import { describe, expect, it } from "vitest";
import { addDevice, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { BatchingService } from "../src/services/batching";
import { bundleHashFromBundle, payloadHash } from "../src/domain/hashing";
import { FakeSequencerClient } from "./helpers/fake-saas";
import { FakeGoogleDriveApi, MemoryTokenStore } from "./helpers/fake-google-drive";
import {
  DRIVE_FILE_SCOPE,
  GoogleDriveAdapter,
  GoogleDriveRevokedError,
  bundleObjectName,
  closingPackObjectName,
  manifestObjectName,
  snapshotObjectName,
} from "../src/services/replica/google-drive-adapter";
import { StorageObjectNotFoundError, createStorageAdapter } from "../src/services/replica/storage-adapter";
import { StorageAdapterTarget } from "../src/services/replica/adapter-target";
import { ReplicaHealthService } from "../src/services/replica/replica-health";
import { configSchema } from "../src/config";

function freshStore(expired = false) {
  return new MemoryTokenStore({
    access_token: "old-token",
    refresh_token: "refresh",
    expiry_date: expired ? Date.now() - 1000 : Date.now() + 3_600_000,
  });
}

function makeAdapter(
  api: FakeGoogleDriveApi,
  store: MemoryTokenStore,
  extra: Record<string, unknown> = {},
) {
  return new GoogleDriveAdapter({
    clientId: "client-id",
    companyId: "cmp_test",
    replicaId: "hub_1",
    tokenStore: store,
    api,
    ...extra,
  });
}

describe("Google Drive object naming", () => {
  it("uses PRD §25 names inside appDataFolder", () => {
    expect(DRIVE_FILE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
    expect(bundleObjectName("b-7-bdl_1")).toBe("b-0000000007-bdl_1.json");
    expect(bundleObjectName("b-0000000007-bdl_1.json")).toBe("b-0000000007-bdl_1.json");
    expect(snapshotObjectName("snap-1")).toBe("snap-1.json");
    expect(snapshotObjectName("id-1")).toBe("snap-id-1.json");
    expect(closingPackObjectName("2026-11")).toBe("close-2026-11.json");
    expect(manifestObjectName("hub_1")).toBe("manifest-hub_1.json");
  });
});

describe("GoogleDriveAdapter contract against fake API", () => {
  it("uploads, lists from cursor, downloads and deletes bundles", async () => {
    const api = new FakeGoogleDriveApi();
    const adapter = makeAdapter(api, freshStore());
    await adapter.connect(null);
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await adapter.uploadBundle("b-7-bdl_1", bytes)).uri).toContain("gdrive://");
    await adapter.uploadBundle("b-9-bdl_2", new Uint8Array([4]));

    expect([...api.files.values()].map((f) => f.name).sort()).toEqual([
      "b-0000000007-bdl_1.json",
      "b-0000000009-bdl_2.json",
    ]);
    expect(Array.from(await adapter.downloadBundle("b-7-bdl_1"))).toEqual([1, 2, 3]);
    expect((await adapter.listBundles()).map((r) => r.key)).toEqual([
      "b-0000000007-bdl_1.json",
      "b-0000000009-bdl_2.json",
    ]);
    expect((await adapter.listBundles("b-0000000007-bdl_1.json")).map((r) => r.key)).toEqual([
      "b-0000000009-bdl_2.json",
    ]);
    await adapter.deleteBundle("b-7-bdl_1");
    expect((await adapter.listBundles()).map((r) => r.key)).toEqual(["b-0000000009-bdl_2.json"]);
    await expect(adapter.downloadBundle("b-7-bdl_1")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("round-trips snapshots, closing packs and the per-replica manifest", async () => {
    const api = new FakeGoogleDriveApi();
    const adapter = makeAdapter(api, freshStore());
    await adapter.connect(null);
    await adapter.uploadSnapshot("snap-1", new Uint8Array([9]));
    await adapter.uploadClosingPack("close-2026-11", new Uint8Array([8]));
    expect(await adapter.getManifest()).toBeNull();
    await adapter.uploadManifest('{"replicaId":"hub_1"}');
    expect(await adapter.getManifest()).toBe('{"replicaId":"hub_1"}');
    expect(Array.from(await adapter.downloadSnapshot("snap-1"))).toEqual([9]);
    expect(Array.from(await adapter.downloadClosingPack("close-2026-11"))).toEqual([8]);
    expect([...api.files.values()].map((f) => f.name).sort()).toEqual([
      "close-2026-11.json",
      "manifest-hub_1.json",
      "snap-1.json",
    ]);
  });

  it("silently refreshes an expired token and persists it", async () => {
    const api = new FakeGoogleDriveApi();
    const store = freshStore(true);
    const adapter = makeAdapter(api, store);
    await adapter.connect(null);
    await adapter.uploadBundle("b-1-bdl_1", new Uint8Array([1]));
    expect(api.refreshCount).toBe(1);
    expect(store.writes).toBe(1);
    expect((await store.read()).access_token).toBe("fresh-token");
    await adapter.uploadBundle("b-2-bdl_2", new Uint8Array([2]));
    expect(api.refreshCount).toBe(1);
  });

  it("pauses sync with a plain reconnect message on revocation", async () => {
    const ctx = makeCtx();
    try {
      const api = new FakeGoogleDriveApi({ revokeOnCall: true });
      const adapter = makeAdapter(api, freshStore());
      await adapter.connect(null);
      await expect(adapter.uploadBundle("b-1-bdl_1", new Uint8Array([1]))).rejects
        .toBeInstanceOf(GoogleDriveRevokedError);
      expect(adapter.isPaused()).toBe(true);
      expect(adapter.driveStatus()).toMatchObject({
        revoked: true,
        message: "Please reconnect your Google account to continue backup.",
        action: "Reconnect Google Drive",
      });
      expect(await adapter.healthCheck()).toBe(false);

      const health = await new ReplicaHealthService({
        config: ctx.config,
        bundles: ctx.bundles,
        manifests: ctx.manifests,
        adapter,
        chainVerify: () => ({ ok: true, checked: 0 }),
      }).check();
      expect(health.level).toBe("CRITICAL");
      expect(health.message).toBe("Please reconnect your Google account to continue backup.");
      expect(health.action).toBe("Reconnect Google Drive");
    } finally {
      ctx.cleanup();
    }
  });

  it("retries rate limits with exponential backoff", async () => {
    const delays: number[] = [];
    const api = new FakeGoogleDriveApi({ failCalls: 2 });
    const adapter = makeAdapter(api, freshStore(), {
      baseDelayMs: 100,
      maxAttempts: 3,
      sleep: async (ms: number) => { delays.push(ms); },
    });
    await adapter.connect(null);
    await adapter.uploadBundle("b-1-bdl_1", new Uint8Array([1]));
    expect(delays).toEqual([100, 200]);
    expect([...api.files.values()]).toHaveLength(1);
  });

  it("accepts only drive.file scope and stays opt-in", async () => {
    const api = new FakeGoogleDriveApi();
    expect(() => makeAdapter(api, freshStore(), {
      scopes: ["https://www.googleapis.com/auth/drive"],
    })).toThrow();
    const parsed = configSchema.safeParse({
      companyId: "c",
      replicaId: "r",
      adminTokenHash: "a".repeat(64),
      dataDir: "/tmp/d",
      logDir: "/tmp/l",
      googleDrive: { scopes: ["https://www.googleapis.com/auth/drive"] },
    });
    expect(parsed.success).toBe(false);
    expect(createStorageAdapter({ adapter: "null" }).name).toBe("null");
    expect(createStorageAdapter({ adapter: "memory" }).name).toBe("memory");
  });
});

describe("sync pause and payload boundary", () => {
  it("paused adapter blocks batching entirely", async () => {
    const ctx = makeCtx();
    try {
      const device = addDevice(ctx);
      const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      ingest.ingest(makeBundle(device.id, null), device);
      let uploads = 0;
      const target = {
        name: "paused",
        isPaused: () => true,
        uploadBundle: async () => { uploads++; throw new Error("should not run"); },
        uploadManifest: async () => {},
        healthCheck: async () => false,
      };
      const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, target, ctx.config);
      await batching.processOnce();
      expect(uploads).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });

  it("sends bundle bytes to Drive but only metadata to SaaS", async () => {
    const ctx = makeCtx();
    try {
      const device = addDevice(ctx);
      const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const b = makeBundle(device.id, null);
      b.payload[0]!.data = { secret: "SECRET_PAYLOAD_XYZ" };
      b.payloadHash = payloadHash(b.payload);
      b.bundleHash = bundleHashFromBundle(b);
      ingest.ingest(b, device);

      const api = new FakeGoogleDriveApi();
      const adapter = makeAdapter(api, freshStore());
      await adapter.connect(null);
      const saas = new FakeSequencerClient();
      const batching = new BatchingService(
        ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, new StorageAdapterTarget(adapter), ctx.config, 300_000, saas,
      );
      await batching.processOnce();

      expect([...api.files.values()].length).toBeGreaterThan(0);
      const driveText = [...api.files.values()]
        .map((f) => Buffer.from(f.bytes).toString("utf8"))
        .join("\n");
      expect(driveText).toContain("SECRET_PAYLOAD_XYZ");
      expect(Object.keys(saas.lastRequest()!).sort()).toEqual([
        "bundleId", "deviceId", "driveUri", "eventCount", "hubOrigin", "payloadHash", "prevHash",
      ]);
      expect(JSON.stringify(saas.lastRequest())).not.toContain("SECRET_PAYLOAD_XYZ");
    } finally {
      ctx.cleanup();
    }
  });
});

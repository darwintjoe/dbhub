import http, { type IncomingHttpHeaders } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  FileDeviceTokenProvider,
  HttpSequencerClient,
  MemoryDeviceTokenProvider,
  SaasSequencingError,
  assertHubOriginAllowed,
  createSequencerClient,
  hashDeviceToken,
  type SequenceMetadata,
} from "../src/services/saas/sequencer-client";
import { FakeSequencerClient } from "./helpers/fake-saas";
import { addDevice, makeApp, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { BatchingService } from "../src/services/batching";
import { NullTarget } from "../src/services/replica/null-target";

function meta(overrides: Partial<SequenceMetadata> = {}): SequenceMetadata {
  return {
    bundleId: "bdl_1",
    prevHash: "prev-hash",
    payloadHash: "payload-hash",
    driveUri: "file:///replica/bdl_1.json",
    eventCount: 3,
    deviceId: "dev_1",
    hubOrigin: true,
    ...overrides,
  };
}

interface Captured {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function withCaptureServer(
  status: number,
  response: unknown,
  handler: (baseUrl: string, captured: () => Captured) => Promise<void>,
): Promise<void> {
  let captured: Captured = { headers: {}, body: {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = {
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("capture server has no port");
  try {
    await handler(`http://127.0.0.1:${addr.port}`, () => captured);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const okResponse = {
  global_sequence_no: 7,
  global_bundle_hash: "g7",
  sequenced_at: "2026-11-21T00:00:00.000Z",
};

describe("HttpSequencerClient", () => {
  it("sends metadata only, with device token and idempotency key", async () => {
    await withCaptureServer(200, okResponse, async (baseUrl, captured) => {
      const client = new HttpSequencerClient({
        baseUrl,
        profile: "solo",
        hubOrigin: true,
        deviceTokenProvider: new MemoryDeviceTokenProvider("machine-token"),
      });
      const result = await client.sequence(meta());
      expect(result).toEqual({
        globalSequenceNo: 7,
        globalBundleHash: "g7",
        sequencedAt: "2026-11-21T00:00:00.000Z",
      });
      const seen = captured();
      expect(Object.keys(seen.body).sort()).toEqual([
        "bundle_id",
        "device_id",
        "drive_uri",
        "event_count",
        "hub_origin",
        "payload_hash",
        "prev_hash",
      ]);
      expect(seen.body).not.toHaveProperty("payload");
      expect(seen.body).not.toHaveProperty("payload_json");
      expect(seen.body.hub_origin).toBe(true);
      expect(seen.headers.authorization).toBe("Bearer machine-token");
      expect(seen.headers["idempotency-key"]).toBe("bdl_1");
    });
  });

  it("maps HTTP rejection and malformed response to typed errors", async () => {
    await withCaptureServer(409, { error: "duplicate" }, async (baseUrl) => {
      const client = new HttpSequencerClient({
        baseUrl,
        profile: "solo",
        hubOrigin: true,
        deviceTokenProvider: new MemoryDeviceTokenProvider("t"),
      });
      await expect(client.sequence(meta())).rejects.toMatchObject({ code: "SAAS-002" });
    });
    await withCaptureServer(200, { nope: true }, async (baseUrl) => {
      const client = new HttpSequencerClient({
        baseUrl,
        profile: "solo",
        hubOrigin: true,
        deviceTokenProvider: new MemoryDeviceTokenProvider("t"),
      });
      await expect(client.sequence(meta())).rejects.toMatchObject({ code: "SAAS-004" });
    });
  });

  it("Profile B blocks non-Hub sequencing before any network call", async () => {
    const client = new HttpSequencerClient({
      baseUrl: "http://127.0.0.1:1",
      profile: "hub_required",
      hubOrigin: false,
      deviceTokenProvider: new MemoryDeviceTokenProvider("t"),
    });
    await expect(client.sequence(meta({ hubOrigin: false }))).rejects.toMatchObject({ code: "SAAS-003" });
  });
});

describe("Profile B enforcement", () => {
  it("assertHubOriginAllowed gates only hub_required", () => {
    expect(() => assertHubOriginAllowed("hub_required", false)).toThrowError(SaasSequencingError);
    expect(() => assertHubOriginAllowed("hub_required", true)).not.toThrow();
    expect(() => assertHubOriginAllowed("solo", false)).not.toThrow();
  });

  it("hub_required relay accepts any authenticated device upload", async () => {
    const ctx = makeCtx();
    try {
      ctx.config.saas.profile = "hub_required";
      const d = addDevice(ctx);
      const { app } = makeApp(ctx);
      const res = await request(app)
        .post("/api/v1/relay/bundles")
        .set("Authorization", "Bearer dev-token")
        .send(makeBundle(d.id, null));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("accepted");
    } finally {
      ctx.cleanup();
    }
  });

  it("relay accepts uploads in solo mode", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const { app } = makeApp(ctx);
      const res = await request(app)
        .post("/api/v1/relay/bundles")
        .set("Authorization", "Bearer dev-token")
        .send(makeBundle(d.id, null));
      expect(res.status).toBe(200);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("device tokens", () => {
  it("hashes at rest and never exposes plaintext in config", async () => {
    const provider = new MemoryDeviceTokenProvider("secret-token");
    expect(await provider.getToken()).toBe("secret-token");
    expect(provider.hashedToken()).toBe(hashDeviceToken("secret-token"));
    expect(provider.hashedToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.hashedToken()).not.toBe("secret-token");
  });

  it("requires mode 0600 for file-backed tokens on POSIX", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbhub-token-"));
    const file = path.join(dir, "hub.token");
    try {
      await fs.writeFile(file, "file-token\n", { mode: 0o600 });
      const provider = new FileDeviceTokenProvider(file);
      expect(await provider.getToken()).toBe("file-token");
      if (process.platform !== "win32") {
        await fs.chmod(file, 0o644);
        await expect(provider.getToken()).rejects.toMatchObject({ code: "SAAS-005" });
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("factory stops at config boundary", () => {
    expect(createSequencerClient({ baseUrl: "", profile: "solo", hubOrigin: false })).toBeNull();
    const client = createSequencerClient(
      { baseUrl: "http://saas.invalid", profile: "hub_required", hubOrigin: true },
      new MemoryDeviceTokenProvider("t"),
    );
    expect(client?.name).toBe("saas-http");
  });
});

describe("FakeSequencerClient", () => {
  it("is idempotent and updates SaaS manifest", async () => {
    const fake = new FakeSequencerClient("solo");
    const first = await fake.sequence(meta({ payloadHash: "ph1" }));
    const replay = await fake.sequence(meta({ payloadHash: "ph1" }));
    expect(replay).toEqual(first);
    expect(fake.requests).toHaveLength(2);
    expect(fake.manifest()).toMatchObject({
      latestBundleId: "bdl_1",
      latestBundleHash: "ph1",
      latestGlobalSequenceNo: first.globalSequenceNo,
    });

    const second = await fake.sequence(meta({ bundleId: "bdl_2", payloadHash: "ph2" }));
    expect(second.globalSequenceNo).toBe(first.globalSequenceNo + 1);
    expect(fake.manifest().latestBundleId).toBe("bdl_2");
  });

  it("rejects non-Hub origin in hub_required mode", async () => {
    const fake = new FakeSequencerClient("hub_required");
    await expect(fake.sequence(meta({ hubOrigin: false }))).rejects.toMatchObject({ code: "SAAS-003" });
    expect(fake.manifest().latestBundleId).toBeNull();
  });
});

describe("batch sequencing integration", () => {
  it("stores global sequence and updates fake SaaS manifest for Hub-origin bundles", async () => {
    const ctx = makeCtx();
    try {
      ctx.config.saas.hubOrigin = true;
      const d = addDevice(ctx);
      const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const b = makeBundle(d.id, null);
      ingest.ingest(b, d);
      const fake = new FakeSequencerClient("hub_required");
      const batching = new BatchingService(
        ctx.db,
        ctx.bundles,
        ctx.manifests,
        ctx.outbox,
        new NullTarget(),
        ctx.config,
        300_000,
        fake,
      );
      await batching.processOnce();

      expect(ctx.bundles.findByBundleId(b.bundleId)?.globalBundleId).toBe(1);
      expect(fake.lastRequest()?.hubOrigin).toBe(true);
      expect(fake.manifest().latestBundleId).toBe(b.bundleId);
      const row = ctx.db.prepare("SELECT status FROM outbox WHERE bundle_id=?").get(b.bundleId) as {
        status: string;
      };
      expect(row.status).toBe("done");
    } finally {
      ctx.cleanup();
    }
  });
});

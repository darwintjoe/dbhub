import { describe, expect, it } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeBundle, makeCtx } from "./helpers";
import { FakeSequencerClient } from "./helpers/fake-saas";
import { IngestService } from "../src/services/ingest";
import { MemoryAdapter } from "../src/services/replica/storage-adapter";
import {
  ReplicaHealthService,
  type ReplicaHealth,
  type ReplicaHealthLevel,
} from "../src/services/replica/replica-health";
import { NumberRelayService } from "../src/services/numbers/number-relay";

function health(level: ReplicaHealthLevel): ReplicaHealth {
  const copy = {
    GOOD: "Your records are safely stored and up to date.",
    WARNING: "Some copies of your records are behind. Normal work can continue.",
    CRITICAL: "Your records need a safety check before new document numbers can be issued.",
  } as const;
  return {
    level,
    score: level === "GOOD" ? 100 : level === "WARNING" ? 70 : 25,
    label: level,
    message: copy[level],
    action: "Review",
    reasons: [],
    checkedAt: new Date().toISOString(),
  };
}

async function seeded() {
  const ctx = makeCtx();
  const adapter = new MemoryAdapter();
  await adapter.connect(null);
  ctx.storageAdapter = adapter;
  const device = addDevice(ctx);
  const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
  let prev: string | null = null;
  for (let i = 1; i <= 3; i++) {
    const b = makeBundle(device.id, prev, i);
    ingest.ingest(b, device);
    prev = b.bundleHash;
  }
  return { ctx, adapter, device };
}

describe("snapshot and closing pack", () => {
  it("writes/reads via the adapter with snap-* and close-* keys and updates the manifest", async () => {
    const { ctx, adapter } = await seeded();
    try {
      const { recovery, maintenance } = makeApp(ctx);
      maintenance.verifyChain();
      const snap = await recovery.writeSnapshot();
      expect(snap.snapshotId).toBeTruthy();
      expect(await adapter.listBundles()).toEqual([]);
      const stored = await adapter.downloadSnapshot(`snap-${snap.snapshotId}`);
      expect(JSON.parse(Buffer.from(stored).toString("utf8"))).toMatchObject({
        snapshotId: snap.snapshotId,
        eventCount: 3,
        chain: { latestAcceptedSeq: 3 },
      });
      expect((await recovery.readSnapshot())?.snapshotId).toBe(snap.snapshotId);

      const pack = await recovery.writeClosingPack("2026-11");
      expect(pack.period).toBe("2026-11");
      const storedPack = await adapter.downloadClosingPack("close-2026-11");
      expect(JSON.parse(Buffer.from(storedPack).toString("utf8"))).toMatchObject({
        closedPeriodId: "close-2026-11",
        period: "2026-11",
      });
      expect((await recovery.readClosingPack("2026-11"))?.period).toBe("2026-11");

      const manifest = ctx.manifests.get(ctx.config.replicaId)!;
      expect(manifest.latestSnapshotId).toBe(snap.snapshotId);
      expect(manifest.latestClosedPeriod).toBe("2026-11");
      expect(await adapter.getManifest()).toContain(snap.snapshotId);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("rebuild drill", () => {
  it("restores derived data from snapshot + bundles + pack and matches chain/status", async () => {
    const { ctx } = await seeded();
    try {
      const { recovery, maintenance } = makeApp(ctx);
      maintenance.verifyChain();
      await recovery.writeSnapshot();
      await recovery.writeClosingPack("2026-11");

      const beforeChain = maintenance.verifyChain();
      const beforeEvents = ctx.bundles.countEvents();
      const beforeHead = ctx.bundles.acceptedHead();

      // Simulate corrupted derived data in a temp copy.
      ctx.db.prepare("DELETE FROM events").run();
      expect(ctx.bundles.countEvents()).toBe(0);

      const result = await recovery.rebuild();
      expect(result.ok).toBe(true);
      expect(result.snapshotId).toBeTruthy();
      expect(result.chain).toEqual(beforeChain);
      expect(result.manifestValid).toBe(true);
      expect(result.closingPacksValid).toBe(true);
      expect(ctx.bundles.countEvents()).toBe(beforeEvents);
      expect(maintenance.verifyChain()).toEqual(beforeChain);
      expect(ctx.bundles.acceptedHead()).toEqual(beforeHead);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("replica health / Data Safety Score", () => {
  it("reports GOOD when chain, copy, summary and recovery point are present", async () => {
    const { ctx } = await seeded();
    try {
      const { recovery, maintenance, replicaHealth } = makeApp(ctx);
      maintenance.verifyChain();
      await recovery.writeSnapshot();
      const result = await replicaHealth.check();
      expect(result.level).toBe("GOOD");
      expect(result.message).toBe("Your records are safely stored and up to date.");
    } finally {
      ctx.cleanup();
    }
  });

  it("reports WARNING without a configured copy and CRITICAL on a broken check", async () => {
    const ctx1 = makeCtx();
    try {
      const service1 = new ReplicaHealthService({
        config: ctx1.config,
        bundles: ctx1.bundles,
        manifests: ctx1.manifests,
        adapter: null,
        chainVerify: () => ({ ok: true, checked: 0 }),
      });
      const warning = await service1.check();
      expect(warning.level).toBe("WARNING");
      expect(warning.message).not.toMatch(/hash|quarantine|divergence/i);
    } finally {
      ctx1.cleanup();
    }

    const ctx2 = makeCtx();
    try {
      const service2 = new ReplicaHealthService({
        config: ctx2.config,
        bundles: ctx2.bundles,
        manifests: ctx2.manifests,
        adapter: new MemoryAdapter(),
        chainVerify: () => ({ ok: false, checked: 2 }),
      });
      const critical = await service2.check();
      expect(critical.level).toBe("CRITICAL");
      expect(critical.message).not.toMatch(/hash|quarantine|divergence/i);
    } finally {
      ctx2.cleanup();
    }
  });

  it("exposes plain-language dataSafety in /api/v1/status", async () => {
    const { ctx } = await seeded();
    try {
      const { app, recovery, maintenance } = makeApp(ctx);
      maintenance.verifyChain();
      await recovery.writeSnapshot();
      const res = await request(app)
        .get("/api/v1/status")
        .set("Authorization", "Bearer dev-token");
      expect(res.status).toBe(200);
      expect(res.body.dataSafety.level).toBe("GOOD");
      expect(res.body.dataSafety.message).toBe("Your records are safely stored and up to date.");
      expect(JSON.stringify(res.body.dataSafety)).not.toMatch(/hash mismatch|quarantine|divergence/i);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("health-gated number relay", () => {
  it("blocks issuance on CRITICAL and warns on WARNING", async () => {
    const ctx = makeCtx();
    try {
      const fake = new FakeSequencerClient();
      const base = () => ({ docType: "INV", prefix: "A", idempotencyKey: "gate-1", deviceId: "dev_1" });
      const critical = new NumberRelayService(ctx.db, fake, 20, () => health("CRITICAL"));
      await expect(critical.next(base())).rejects.toMatchObject({ code: "NUM-009" });

      const warning = new NumberRelayService(ctx.db, fake, 20, () => health("WARNING"));
      const result = await warning.next(base());
      expect(result.number).toBe(1);
      expect(result.warning).toBe("Some copies of your records are behind. Normal work can continue.");
    } finally {
      ctx.cleanup();
    }
  });
});

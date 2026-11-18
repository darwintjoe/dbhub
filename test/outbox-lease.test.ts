import { describe, expect, it } from "vitest";
import { addDevice, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { BatchingService } from "../src/services/batching";
import type { ReplicaTarget } from "../src/services/replica/target";
import type { Manifest, StoredBundle } from "../src/domain/types";

class StubTarget implements ReplicaTarget {
  readonly name = "stub";
  calls = 0;
  constructor(public delayMs = 0) {}
  async uploadBundle(_bundle: StoredBundle): Promise<{ uri: string }> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return { uri: "stub://ok" };
  }
  async uploadManifest(_m: Manifest): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function setup() {
  const ctx = makeCtx();
  const d = addDevice(ctx);
  const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
  const b = makeBundle(d.id, null, 1);
  ingest.ingest(b, d);
  const row = ctx.outbox.duePending(new Date(Date.now() + 60_000).toISOString(), 10)[0];
  return { ctx, b, row };
}

function outboxRow(ctx: ReturnType<typeof makeCtx>, id: number) {
  return ctx.db.prepare("SELECT status, lease_expires_at FROM outbox WHERE id=?").get(id) as {
    status: string;
    lease_expires_at: string | null;
  };
}

describe("outbox lease recovery (P2-4)", () => {
  it("reclaims an expired uploading row on processOnce", async () => {
    const { ctx, row } = setup();
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      ctx.db.prepare("UPDATE outbox SET status='uploading', lease_expires_at=? WHERE id=?").run(past, row.id);
      const target = new StubTarget();
      const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, target, ctx.config);
      await batching.processOnce(new Date(Date.now() + 60_000).toISOString());
      expect(target.calls).toBe(1);
      expect(outboxRow(ctx, row.id).status).toBe("done");
      expect(outboxRow(ctx, row.id).lease_expires_at).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it("startup reset turns uploading into pending and clears the lease", () => {
    const { ctx, row } = setup();
    try {
      ctx.db
        .prepare("UPDATE outbox SET status='uploading', lease_expires_at=? WHERE id=?")
        .run(new Date(Date.now() + 60_000).toISOString(), row.id);
      const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, new StubTarget(), ctx.config);
      expect(batching.resetOnStartup()).toBe(1);
      expect(outboxRow(ctx, row.id).status).toBe("pending");
      expect(outboxRow(ctx, row.id).lease_expires_at).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it("stop() waits for in-flight work", async () => {
    const { ctx, row } = setup();
    try {
      const target = new StubTarget(50);
      const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, target, ctx.config);
      const running = batching.processOnce();
      await batching.stop();
      await running;
      expect(outboxRow(ctx, row.id).status).toBe("done");
    } finally {
      ctx.cleanup();
    }
  });

  it("a hung target past the lease is reclaimed and retried", async () => {
    const { ctx, row } = setup();
    try {
      const target = new StubTarget(60);
      const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, target, ctx.config, 10);
      const t0 = new Date("2026-11-18T10:00:00.000Z").toISOString();
      const first = batching.processOnce(t0);
      await new Promise((r) => setTimeout(r, 30));
      expect(batching.reclaimExpiredLeases("2026-11-18T10:00:00.030Z")).toBe(1);
      await first; // stale completion must not overwrite the reclaimed row
      expect(outboxRow(ctx, row.id).status).toBe("pending");
      target.delayMs = 0;
      await batching.processOnce("2026-11-18T10:00:00.040Z");
      expect(target.calls).toBe(2);
      expect(outboxRow(ctx, row.id).status).toBe("done");
    } finally {
      ctx.cleanup();
    }
  });
});

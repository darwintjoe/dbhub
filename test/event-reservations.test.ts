import { describe, expect, it } from "vitest";
import { addDevice, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { MaintenanceService } from "../src/services/maintenance";
import { bundleHashFromBundle, payloadHash } from "../src/domain/hashing";

function service(ctx: ReturnType<typeof makeCtx>) {
  return new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
}

function reservationCount(ctx: ReturnType<typeof makeCtx>): number {
  const r = ctx.db.prepare("SELECT COUNT(*) AS c FROM pending_event_ids").get() as { c: number };
  return r.c;
}

function withEventId(b: ReturnType<typeof makeBundle>, id: string) {
  b.payload[0].id = id;
  b.payloadHash = payloadHash(b.payload);
  b.bundleHash = bundleHashFromBundle(b);
  return b;
}

describe("event reservation lifecycle (P2-3)", () => {
  it("releases reservations on timeout so the id can be used later", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const orphan = withEventId(makeBundle(d.id, "f".repeat(64), 1), "evt_x");
      expect(service(ctx).ingest(orphan, d)).toEqual({ status: "pending_parent" });
      expect(reservationCount(ctx)).toBe(1);
      expect(ctx.bundles.countEvents()).toBe(0);

      const mt = new MaintenanceService(ctx.db, ctx.bundles, ctx.config);
      expect(mt.sweepPendingParents(new Date(Date.now() + 5000).toISOString())).toBe(1);
      expect(reservationCount(ctx)).toBe(0);

      const fresh = withEventId(makeBundle(d.id, null, 2), "evt_x");
      expect(service(ctx).ingest(fresh, d)).toMatchObject({ status: "accepted" });
      expect(ctx.bundles.countEvents()).toBe(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("moves reservations into events exactly once when pending resolves", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b1 = makeBundle(d.id, null, 1);
      const b2 = makeBundle(d.id, b1.bundleHash, 2);
      expect(svc.ingest(b2, d)).toEqual({ status: "pending_parent" });
      expect(ctx.bundles.countEvents()).toBe(0);
      expect(svc.ingest(b1, d)).toMatchObject({ status: "accepted" });
      expect(ctx.bundles.countByStatus("accepted")).toBe(2);
      expect(ctx.bundles.countEvents()).toBe(2);
      expect(reservationCount(ctx)).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });

  it("quarantines a reservation collision from another device", () => {
    const ctx = makeCtx();
    try {
      const a = addDevice(ctx, "dev_a");
      const b = addDevice(ctx, "dev_b");
      const svc = service(ctx);
      const first = withEventId(makeBundle(a.id, "a".repeat(64), 1), "evt_shared");
      const second = withEventId(makeBundle(b.id, "b".repeat(64), 1), "evt_shared");
      expect(svc.ingest(first, a)).toEqual({ status: "pending_parent" });
      expect(svc.ingest(second, b)).toEqual({ status: "quarantined", reason: "duplicate_event" });
      expect(reservationCount(ctx)).toBe(1);
      expect(ctx.bundles.countEvents()).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });

  it("quarantines an event race at acceptance time without throwing", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const parent = makeBundle(d.id, null, 1);
      const child = withEventId(makeBundle(d.id, parent.bundleHash, 2), "evt_race");
      expect(svc.ingest(child, d)).toEqual({ status: "pending_parent" });
      expect(reservationCount(ctx)).toBe(1);

      // Another bundle won the id while child waited.
      ctx.db
        .prepare("INSERT INTO events (event_id, bundle_id, type, occurred_at, device_id) VALUES (?,?,?,?,?)")
        .run("evt_race", child.bundleId, "journal.posted", null, d.id);

      expect(svc.ingest(parent, d)).toMatchObject({ status: "accepted" });
      const stored = ctx.bundles.findByBundleId(child.bundleId)!;
      expect(stored.status).toBe("quarantined");
      expect(stored.quarantineReason).toBe("duplicate_event");
      expect(reservationCount(ctx)).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { addDevice, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { MaintenanceService } from "../src/services/maintenance";

afterEach(() => vi.useRealTimers());

function service(ctx: ReturnType<typeof makeCtx>) {
  return new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
}

describe("per-device chain and hub chain", () => {
  it("requires null first hash and correct continuation", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b1 = makeBundle(d.id, null, 1);
      const b2 = makeBundle(d.id, b1.bundleHash, 2);
      expect(svc.ingest(b1, d)).toMatchObject({ status: "accepted" });
      expect(svc.ingest(b2, d)).toMatchObject({ status: "accepted" });
      expect(ctx.bundles.getDeviceHead(d.id)).toBe(b2.bundleHash);
    } finally {
      ctx.cleanup();
    }
  });

  it("resolves out-of-order parent", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b1 = makeBundle(d.id, null, 1);
      const b2 = makeBundle(d.id, b1.bundleHash, 2);
      const b3 = makeBundle(d.id, b2.bundleHash, 3);
      expect(svc.ingest(b2, d)).toEqual({ status: "pending_parent" });
      expect(svc.ingest(b3, d)).toEqual({ status: "pending_parent" });
      expect(ctx.bundles.countByStatus("pending_parent")).toBe(2);
      expect(svc.ingest(b1, d)).toMatchObject({ status: "accepted" });
      expect(ctx.bundles.countByStatus("accepted")).toBe(3);
      expect(ctx.bundles.countByStatus("pending_parent")).toBe(0);
      const mt = new MaintenanceService(ctx.db, ctx.bundles, ctx.config);
      expect(mt.verifyChain()).toEqual({ ok: true, checked: 3 });
    } finally {
      ctx.cleanup();
    }
  });

  it("quarantines pending parent after timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const orphan = makeBundle(d.id, "f".repeat(64), 1);
      expect(svc.ingest(orphan, d)).toEqual({ status: "pending_parent" });
      vi.advanceTimersByTime(2000);
      const mt = new MaintenanceService(ctx.db, ctx.bundles, ctx.config);
      expect(mt.sweepPendingParents(new Date().toISOString())).toBe(1);
      const row = ctx.bundles.findByBundleId(orphan.bundleId);
      expect(row?.status).toBe("quarantined");
      expect(row?.quarantineReason).toBe("missing_parent");
    } finally {
      ctx.cleanup();
      vi.useRealTimers();
    }
  });
});

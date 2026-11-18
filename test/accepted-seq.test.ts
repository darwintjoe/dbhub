import { describe, expect, it } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { MaintenanceService } from "../src/services/maintenance";

function service(ctx: ReturnType<typeof makeCtx>) {
  return new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
}

describe("accepted_seq (P1-1)", () => {
  it("keeps accepted chain values immutable and pulls in acceptance order", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b1 = makeBundle(d.id, null, 1);
      const b2 = makeBundle(d.id, b1.bundleHash, 2);
      const b3 = makeBundle(d.id, b2.bundleHash, 3);
      const b4 = makeBundle(d.id, b3.bundleHash, 4);

      expect(svc.ingest(b1, d)).toMatchObject({ status: "accepted" });
      const seq1 = ctx.bundles.findByBundleId(b1.bundleId)!;
      const before = ctx.db
        .prepare("SELECT chain_prev_hash, chain_hash FROM bundles WHERE hub_seq=?")
        .get(seq1.hubSeq);

      // Deliberately post grandchildren before the parent. They stay pending.
      expect(svc.ingest(b3, d)).toEqual({ status: "pending_parent" });
      expect(svc.ingest(b4, d)).toEqual({ status: "pending_parent" });
      expect(svc.ingest(b2, d)).toMatchObject({ status: "accepted" });

      const after = ctx.db
        .prepare("SELECT chain_prev_hash, chain_hash FROM bundles WHERE hub_seq=?")
        .get(seq1.hubSeq);
      expect(after).toEqual(before);

      const mt = new MaintenanceService(ctx.db, ctx.bundles, ctx.config);
      expect(mt.verifyChain()).toEqual({ ok: true, checked: 4 });

      const seqs = ctx.db
        .prepare("SELECT accepted_seq FROM bundles WHERE status='accepted' ORDER BY accepted_seq ASC")
        .all() as { accepted_seq: number }[];
      expect(seqs.map((r) => r.accepted_seq)).toEqual([1, 2, 3, 4]);

      const { app } = makeApp(ctx);
      const pulled = await request(app).get("/api/v1/pull?since=0&limit=200").set("Authorization", "Bearer dev-token");
      expect(pulled.body.bundles.map((b: { bundleId: string }) => b.bundleId)).toEqual([
        b1.bundleId,
        b2.bundleId,
        b3.bundleId,
        b4.bundleId,
      ]);
      expect(pulled.body.bundles.map((b: { acceptedSeq: number }) => b.acceptedSeq)).toEqual([1, 2, 3, 4]);
      expect(pulled.body.nextSince).toBe(4);
    } finally {
      ctx.cleanup();
    }
  }, 20000);

  it("ingests 2,000 bundles without quadratic chain rewrites", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      // Timing guard only: disable fsync so the assertion measures query
      // complexity, not Windows disk commit latency.
      ctx.db.pragma("synchronous = OFF");
      let prev: string | null = null;
      const started = Date.now();
      for (let i = 1; i <= 2000; i++) {
        const b = makeBundle(d.id, prev, i);
        svc.ingest(b, d);
        prev = b.bundleHash;
      }
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(20_000);
      expect(ctx.bundles.countByStatus("accepted")).toBe(2000);
      const row = ctx.db.prepare("SELECT MAX(accepted_seq) AS m FROM bundles").get() as { m: number };
      expect(row.m).toBe(2000);
    } finally {
      ctx.cleanup();
    }
  }, 30000);
});

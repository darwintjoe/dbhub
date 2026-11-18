import { describe, expect, it } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";

const admin = { Authorization: "Bearer admin-token" };
const device = { Authorization: "Bearer dev-token" };

describe("pull and manifest", () => {
  it("registration -> push -> pull roundtrip", async () => {
    const ctx = makeCtx();
    try {
      const { app } = makeApp(ctx);
      const reg = await request(app)
        .post("/api/v1/admin/devices")
        .set(admin)
        .send({ label: "KASIR-1", prefix: "KASIR1" });
      expect(reg.status).toBe(201);
      expect(reg.body.token).toMatch(/^fzh_/);

      const svc = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const d = ctx.devices.findById(reg.body.deviceId)!;
      const b = makeBundle(d.id, null);
      expect(svc.ingest(b, d)).toMatchObject({ status: "accepted" });

      const pulled = await request(app).get("/api/v1/pull?since=0&limit=10").set("Authorization", `Bearer ${reg.body.token}`);
      expect(pulled.status).toBe(200);
      expect(pulled.body.bundles).toHaveLength(1);
      expect(pulled.body.bundles[0].bundleId).toBe(b.bundleId);
      expect(pulled.body.bundles[0].payload).toEqual(b.payload);
    } finally {
      ctx.cleanup();
    }
  });

  it("pagination, order and nextSince", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const { app } = makeApp(ctx);
      const svc = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      let prev: string | null = null;
      for (let i = 1; i <= 5; i++) {
        const b = makeBundle(d.id, prev, i);
        expect(svc.ingest(b, d)).toMatchObject({ status: "accepted" });
        prev = b.bundleHash;
      }
      const r1 = await request(app).get("/api/v1/pull?since=0&limit=2").set(device);
      expect(r1.body.bundles).toHaveLength(2);
      expect(r1.body.bundles[0].hubSeq).toBeLessThan(r1.body.bundles[1].hubSeq);
      expect(r1.body.nextSince).toBe(r1.body.bundles[1].hubSeq);

      const r2 = await request(app).get(`/api/v1/pull?since=${r1.body.nextSince}&limit=2`).set(device);
      expect(r2.body.bundles[0].hubSeq).toBeGreaterThan(r1.body.nextSince);

      const r3 = await request(app).get("/api/v1/pull?since=999&limit=2").set(device);
      expect(r3.body.bundles).toHaveLength(0);
      expect(r3.body.nextSince).toBe(999);
    } finally {
      ctx.cleanup();
    }
  });

  it("chain verify endpoint detects a corrupted row", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const { app } = makeApp(ctx);
      const svc = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const b = makeBundle(d.id, null);
      const res = svc.ingest(b, d) as { hubSeq: number };
      ctx.db.prepare("UPDATE bundles SET chain_hash=? WHERE hub_seq=?").run("f".repeat(64), res.hubSeq);
      const r = await request(app).post("/api/v1/admin/maintenance/verify-chain").set(admin);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(r.body.firstBadHubSeq).toBe(res.hubSeq);
    } finally {
      ctx.cleanup();
    }
  });

  it("manifest is correct after N pushes", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const { app } = makeApp(ctx);
      const svc = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      let prev: string | null = null;
      let last: { bundleId: string; bundleHash: string } | null = null;
      for (let i = 1; i <= 3; i++) {
        const b = makeBundle(d.id, prev, i);
        expect(svc.ingest(b, d)).toMatchObject({ status: "accepted" });
        prev = b.bundleHash;
        last = b;
      }
      const m = await request(app).get("/api/v1/manifest").set(device);
      expect(m.status).toBe(200);
      expect(m.body.latestHubSeq).toBe(3);
      expect(m.body.latestBundleId).toBe(last!.bundleId);
      expect(m.body.latestBundleHash).toBe(last!.bundleHash);
      expect(m.body.replicaId).toBe("hub_test");
      expect(m.body.replicaType).toBe("hub");
    } finally {
      ctx.cleanup();
    }
  });
});

import { describe, expect, it } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { bundleHashFromBundle, payloadHash } from "../src/domain/hashing";

describe("admin overview extended fields", () => {
  it("exposes connectivity, storage, backup, chain verify and device activity without leaking payloads", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const b = makeBundle(d.id, null);
      b.payload[0]!.data = { secret: "SECRET_PAYLOAD_XYZ" };
      b.payloadHash = payloadHash(b.payload);
      b.bundleHash = bundleHashFromBundle(b);
      ingest.ingest(b, d);

      const { app } = makeApp(ctx);
      const r = await request(app).get("/api/v1/admin/overview").set("Authorization", "Bearer admin-token");
      expect(r.status).toBe(200);
      const body = r.body;

      expect(body.connectivity).toBeTruthy();
      expect(typeof body.connectivity.mode).toBe("string");
      expect(body.connectivity.tunnel).toHaveProperty("status");

      expect(body.storage).toBeTruthy();
      expect(body.storage).toHaveProperty("target");
      expect(body.storage).toHaveProperty("ready");
      expect(body.storage).toHaveProperty("freeBytes");

      expect(body.backup).toBeTruthy();
      expect(body.backup).toHaveProperty("lastAt");
      expect(body.backup).toHaveProperty("count");

      expect(body.chain.verify).toBeTruthy();
      expect(body.chain.verify).toHaveProperty("ok");
      expect(body.chain.verify).toHaveProperty("verifiedAt");
      expect(body.chain.verify).toHaveProperty("stale");

      expect(typeof body.devicesOnline).toBe("number");
      expect(Array.isArray(body.devices)).toBe(true);
      expect(body.devices[0]).toHaveProperty("recentAccepted");
      expect(body.devices[0]).toHaveProperty("recentEvents");

      expect(body.historyMeta).toBeTruthy();
      expect(body.historyMeta).toHaveProperty("intervalMs");
      expect(body.historyMeta).toHaveProperty("capacity");

      expect(body.outbox).toHaveProperty("oldestPendingAgeMs");
      expect(body.outbox).toHaveProperty("lastSuccessAt");

      // Live replica shape: local hub only, never a claimed cloud/SAL connection.
      expect(body.replica).toBeTruthy();
      expect(body.replica.target).toBe("null");
      expect(body.replica.sal.connected).toBe(false);
      expect(body.replica.sal.provider).toBeNull();
      expect(body.replica.sal.health).toBe("Not configured");
      expect(body.replica.manifest.aligned).toBeNull();
      expect(body.replica.manifest.localOnly).toBe(true);
      expect(body.replica.numberRelay.active).toBe(false);
      expect(body.replica.numberRelay.detail).toBe("Not implemented");
      expect(body.replica.monitored).toBe(1);
      expect(body.replica.total).toBe(4);
      expect(body.replica.replicas).toHaveLength(1);
      expect(body.replica.replicas[0].type).toBe("hub");
      expect(body.replica.replicas[0].online).toBe(true);

      // Chain strip uses only non-sensitive fields.
      expect(Array.isArray(body.chain.recent)).toBe(true);
      for (const item of body.chain.recent) {
        expect(Object.keys(item).sort()).toEqual(["acceptedSeq", "status"]);
      }

      // Polling mode gets history (and time labels) from /overview.
      expect(body.history).toBeTruthy();
      expect(Array.isArray(body.history.cpu)).toBe(true);
      expect(Array.isArray(body.history.timeLabels)).toBe(true);
      expect(body.history.timeLabels.length).toBe(body.history.cpu.length);

      const text = JSON.stringify(body);
      expect(text).not.toContain("SECRET_PAYLOAD_XYZ");
      expect(text).not.toContain("dev-token");
      expect(text).not.toContain("admin-token");
      expect(text).not.toContain("payload_json");
      expect(text).not.toContain("adminToken");
      expect(text).not.toContain("csrfToken");
      expect(text).not.toContain("tokenHash");
    } finally {
      ctx.cleanup();
    }
  });

  it("reports a folder replica target honestly without claiming cloud SAL", async () => {
    const ctx = makeCtx();
    try {
      ctx.config.storage.target = "folder";
      ctx.config.storage.folderPath = ctx.config.dataDir;
      const { app } = makeApp(ctx);
      const r = await request(app).get("/api/v1/admin/overview").set("Authorization", "Bearer admin-token");
      expect(r.status).toBe(200);
      expect(r.body.storage.target).toBe("folder");
      expect(r.body.storage.ready).toBe(true);
      expect(r.body.replica.target).toBe("folder");
      expect(r.body.replica.sal.connected).toBe(false);
      expect(r.body.replica.sal.health).toBe("Not configured");
      expect(r.body.replica.monitored).toBe(1);
    } finally {
      ctx.cleanup();
    }
  });
});

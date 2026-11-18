import { describe, expect, it } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { bundleHashFromBundle, payloadHash } from "../src/domain/hashing";

describe("dashboard UI", () => {
  it("shows counts and never leaks payload or token", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const b = makeBundle(d.id, null);
      b.payload[0].data = { secret: "SECRET_PAYLOAD_XYZ" };
      b.payloadHash = payloadHash(b.payload);
      b.bundleHash = bundleHashFromBundle(b);
      ingest.ingest(b, d);

      const { app } = makeApp(ctx);
      const r = await request(app).get("/");
      expect(r.status).toBe(200);
      expect(r.text).toContain("FAZAI Hub");
      expect(r.text).toContain("Accepted: 1");
      expect(r.text).toContain("Verify chain");
      expect(r.text).not.toContain("SECRET_PAYLOAD_XYZ");
      expect(r.text).not.toContain("dev-token");
    } finally {
      ctx.cleanup();
    }
  });
});

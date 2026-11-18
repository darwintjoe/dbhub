import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeApp, makeCtx } from "./helpers";

const admin = { Authorization: "Bearer admin-token" };

describe("device prefix creation (P3)", () => {
  it("returns 409 BUNDLE-006 for an explicit duplicate prefix", async () => {
    const ctx = makeCtx();
    try {
      const { app } = makeApp(ctx);
      const first = await request(app).post("/api/v1/admin/devices").set(admin).send({ label: "A", prefix: "SAME" });
      expect(first.status).toBe(201);
      expect(first.body.prefix).toBe("SAME");

      const second = await request(app).post("/api/v1/admin/devices").set(admin).send({ label: "B", prefix: "SAME" });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("BUNDLE-006");

      const list = await request(app).get("/api/v1/admin/devices").set(admin);
      expect(list.body.devices).toHaveLength(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("auto-suggests the next unused prefix", async () => {
    const ctx = makeCtx();
    try {
      const { app } = makeApp(ctx);
      const a = await request(app).post("/api/v1/admin/devices").set(admin).send({ label: "A" });
      const b = await request(app).post("/api/v1/admin/devices").set(admin).send({ label: "B" });
      expect(a.body.prefix).toBe("A");
      expect(b.body.prefix).toBe("B");
    } finally {
      ctx.cleanup();
    }
  });
});

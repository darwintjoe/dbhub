import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeApp, makeCtx } from "./helpers";

describe("admin p0", () => {
  it("invalid config returns 400 JSON", async () => {
    const ctx = makeCtx();
    try {
      const { app } = makeApp(ctx);
      const token = "admin-token";
      // set hash
      const r = await request(app).put("/api/v1/admin/config").set("Authorization", "Bearer " + token).set("Content-Type", "application/json").send({ config: { host: 123 } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("CONFIG-001");
    } finally { ctx.cleanup(); }
  });

  it("GET then PUT redacted config is no-op", async () => {
    const ctx = makeCtx();
    try {
      const { app, configService } = makeApp(ctx);
      const token = "admin-token";
      const g = await request(app).get("/api/v1/admin/config").set("Authorization", "Bearer " + token);
      const put = await request(app).put("/api/v1/admin/config").set("Authorization", "Bearer " + token).set("Content-Type", "application/json").send({ config: g.body.config, baseHash: g.body.hash });
      expect(put.status).toBe(200);
      expect(put.body.restartRequired).toEqual([]);
      expect(configService.getHash()).toBe(g.body.hash);
    } finally { ctx.cleanup(); }
  });

  it("restart field is not applied live", async () => {
    const ctx = makeCtx();
    try {
      const { app, configService } = makeApp(ctx);
      const token = "admin-token";
      const g = await request(app).get("/api/v1/admin/config").set("Authorization", "Bearer " + token);
      const cfg = g.body.config;
      cfg.host = "127.0.0.2";
      const put = await request(app).put("/api/v1/admin/config").set("Authorization", "Bearer " + token).set("Content-Type", "application/json").send({ config: cfg, baseHash: g.body.hash, force: true });
      expect(put.status).toBe(200);
      expect(put.body.restartRequired).toContain("host");
      expect(ctx.config.host).not.toBe("127.0.0.2");
    } finally { ctx.cleanup(); }
  });
});

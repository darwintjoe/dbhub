import { describe, expect, it } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeCtx } from "./helpers";
import { sha256Hex } from "../src/domain/hashing";

const admin = { Authorization: "Bearer admin-token" };

describe("auth matrix", () => {
  it("rejects missing and bad tokens", async () => {
    const ctx = makeCtx();
    try {
      const { app } = makeApp(ctx);
      const no = await request(app).get("/api/v1/status");
      expect(no.status).toBe(401);
      expect(no.body.error.code).toBe("AUTH-001");

      const bad = await request(app).get("/api/v1/status").set("Authorization", "Bearer nope");
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe("AUTH-001");
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects revoked device", async () => {
    const ctx = makeCtx();
    try {
      addDevice(ctx);
      ctx.devices.revoke("dev_1");
      const { app } = makeApp(ctx);
      const r = await request(app).get("/api/v1/status").set("Authorization", "Bearer dev-token");
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("AUTH-002");
    } finally {
      ctx.cleanup();
    }
  });

  it("admin endpoints require admin token", async () => {
    const ctx = makeCtx();
    try {
      addDevice(ctx);
      const { app } = makeApp(ctx);
      const asDevice = await request(app).get("/api/v1/admin/devices").set("Authorization", "Bearer dev-token");
      expect(asDevice.status).toBe(401);
      const asAdmin = await request(app).get("/api/v1/admin/devices").set(admin);
      expect(asAdmin.status).toBe(200);

      const statusWithAdmin = await request(app).get("/api/v1/status").set(admin);
      expect(statusWithAdmin.status).toBe(200);
      expect(statusWithAdmin.body.companyId).toBe("cmp_test");
    } finally {
      ctx.cleanup();
    }
  });

  it("accepts well-known dev token if hash configured", async () => {
    const ctx = makeCtx();
    try {
      ctx.config.adminTokenHash = sha256Hex("dev-admin-token");
      const { app } = makeApp(ctx);
      const r = await request(app).get("/api/v1/admin/devices").set("Authorization", "Bearer dev-admin-token");
      expect(r.status).toBe(200);
    } finally {
      ctx.cleanup();
    }
  });
});

import express from "express";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeCtx } from "./helpers";
import { createErrorHandler } from "../src/http/errors";

describe("HTTP error mapping (P2-5)", () => {
  it("maps malformed JSON to 400 BUNDLE-001", async () => {
    const ctx = makeCtx();
    try {
      addDevice(ctx);
      const { app } = makeApp(ctx);
      const r = await request(app)
        .post("/api/v1/relay/bundles")
        .set("Authorization", "Bearer dev-token")
        .set("Content-Type", "application/json")
        .send("{not-json");
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("BUNDLE-001");
      expect(r.body.error.message).toBe("Malformed JSON body.");
      expect(r.body.error.details).toEqual({});
    } finally {
      ctx.cleanup();
    }
  });

  it("maps oversized bodies to 413 BUNDLE-007", async () => {
    const ctx = makeCtx();
    try {
      addDevice(ctx);
      ctx.config.limits.maxBodyBytes = 1024;
      const { app } = makeApp(ctx);
      const r = await request(app)
        .post("/api/v1/relay/bundles")
        .set("Authorization", "Bearer dev-token")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ blob: "a".repeat(2000) }));
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe("BUNDLE-007");
      expect(r.body.error.details).toEqual({});
    } finally {
      ctx.cleanup();
    }
  });

  it("returns 415 for non-JSON POST", async () => {
    const ctx = makeCtx();
    try {
      addDevice(ctx);
      const { app } = makeApp(ctx);
      const r = await request(app)
        .post("/api/v1/relay/bundles")
        .set("Authorization", "Bearer dev-token")
        .set("Content-Type", "text/plain")
        .send("hello");
      expect(r.status).toBe(415);
      expect(r.body.error.code).toBe("BUNDLE-001");
    } finally {
      ctx.cleanup();
    }
  });

  it("never leaks internal errors and logs them server-side", async () => {
    const logger = { error: vi.fn() };
    const app = express();
    app.get("/boom", () => {
      throw new Error("SECRET SQL DETAIL");
    });
    app.use(createErrorHandler(logger));
    const r = await request(app).get("/boom");
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("SYS-500");
    expect(r.body.error.details).toEqual({});
    expect(JSON.stringify(r.body)).not.toContain("SECRET SQL DETAIL");
    expect(logger.error).toHaveBeenCalled();
  });
});

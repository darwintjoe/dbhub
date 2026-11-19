import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { makeCtx } from "./helpers";
import { createAdminApp } from "../src/app";
import { DEV_CSRF_TOKEN, DEV_NO_AUTH_ENV } from "../src/http/dev-no-auth";

const original = process.env[DEV_NO_AUTH_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[DEV_NO_AUTH_ENV];
  else process.env[DEV_NO_AUTH_ENV] = original;
});

describe("dev no-auth mode", () => {
  it("reports an authenticated session with no setup required", async () => {
    process.env[DEV_NO_AUTH_ENV] = "1";
    const ctx = makeCtx();
    try {
      const app = createAdminApp(ctx) as any;
      const res = await request(app).get("/api/v1/admin/session");
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.setupRequired).toBe(false);
      expect(res.body.csrfToken).toBe(DEV_CSRF_TOKEN);
    } finally {
      ctx.cleanup();
    }
  });

  it("allows protected routes without cookie, bearer token or CSRF header", async () => {
    process.env[DEV_NO_AUTH_ENV] = "true";
    const ctx = makeCtx();
    try {
      const app = createAdminApp(ctx) as any;
      const get = await request(app).get("/api/v1/admin/devices");
      expect(get.status).toBe(200);

      const post = await request(app).post("/api/v1/admin/config/validate").send({ config: ctx.config });
      expect(post.status).toBe(200);
    } finally {
      ctx.cleanup();
    }
  });

  it("accepts any password on login", async () => {
    process.env[DEV_NO_AUTH_ENV] = "yes";
    const ctx = makeCtx();
    try {
      const app = createAdminApp(ctx) as any;
      const res = await request(app).post("/api/v1/admin/session").send({ password: "" });
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.csrfToken).toBe(DEV_CSRF_TOKEN);
      expect(res.body.expiresAt).toBeTruthy();
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps normal auth when the flag is unset", async () => {
    delete process.env[DEV_NO_AUTH_ENV];
    const ctx = makeCtx();
    try {
      const app = createAdminApp(ctx) as any;
      const session = await request(app).get("/api/v1/admin/session");
      expect(session.body.authenticated).toBe(false);
      expect(session.body.setupRequired).toBe(true);

      const denied = await request(app).get("/api/v1/admin/devices");
      expect(denied.status).toBe(401);
      expect(denied.body.error.code).toBe("AUTH-001");
    } finally {
      ctx.cleanup();
    }
  });
});

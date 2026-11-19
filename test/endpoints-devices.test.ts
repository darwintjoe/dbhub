import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeCtx } from "./helpers";
import { createAdminApp } from "../src/app";
import { sha256Hex } from "../src/domain/hashing";

describe("endpoints devices", () => {
  async function setup(ctx: any) {
    const app = createAdminApp(ctx) as any;
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const setupRes = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
    const cookie = setupRes.headers["set-cookie"]?.[0];
    const csrf = setupRes.body.csrfToken;
    return { app, cookie, csrf };
  }

  it("hubUrl from resolver not Host header", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf } = await setup(ctx);
    const res = await request(app).post("/api/v1/admin/devices").set("Cookie", cookie).set("X-CSRF-Token", csrf).set("Host", "evil.example").send({ label: "dev" });
    expect(res.status).toBe(201);
    expect(res.body.hubUrl).not.toContain("evil.example");
    expect(res.body.endpoints).toBeTruthy();
    expect(res.body.endpoints.lan).toBeTruthy();
    ctx.cleanup();
  });

  it("prefix collision retries", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf } = await setup(ctx);
    // pre-insert prefix A
    ctx.devices.create({ id: "dev_existing", companyId: ctx.config.companyId, prefix: "A", label: "x", tokenHash: sha256Hex("t"), status: "approved", createdAt: new Date().toISOString(), lastSeenAt: null, scopes: ["relay:write","pull:read","manifest:read"] });
    const res = await request(app).post("/api/v1/admin/devices").set("Cookie", cookie).set("X-CSRF-Token", csrf).send({ label: "dev2" });
    expect(res.status).toBe(201);
    expect(res.body.prefix).not.toBe("A");
    ctx.cleanup();
  });
});
import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeCtx } from "./helpers";
import { createAdminApp, createPublicApp } from "../src/app";
import { sha256Hex } from "../src/domain/hashing";

describe("appliance public listener", () => {
  it("public routes only", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const pub = createPublicApp(ctx) as any;

    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const setupRes = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
    const cookie = setupRes.headers["set-cookie"]?.[0];
    const csrf = setupRes.body.csrfToken;
    const devRes = await request(app).post("/api/v1/admin/devices").set("Cookie", cookie).set("X-CSRF-Token", csrf).send({ label: "dev" });
    const token = devRes.body.token;

    const adminRes = await request(pub).get("/api/v1/admin/devices");
    expect(adminRes.status).toBe(404);
    const uiRes = await request(pub).get("/admin");
    expect(uiRes.status).toBe(404);
    const healthRes = await request(pub).get("/healthz");
    expect(healthRes.status).toBe(200);
    const relayRes = await request(pub).post("/api/v1/relay/bundles").set("Authorization", "Bearer " + token).send({});
    expect([400, 415]).toContain(relayRes.status);
    ctx.cleanup();
  });
});
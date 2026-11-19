import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { makeCtx, makeConfig } from "./helpers";
import { createAdminApp, createPublicApp } from "../src/app";
import { sha256Hex } from "../src/domain/hashing";

describe("appliance smoke", () => {
  it("setup + session + pairing + public 404", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const pub = createPublicApp(ctx) as any;

    // insert setup code
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now()+30*60*1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);

    // setup
    const setupRes = await request(app).post("/api/v1/admin/setup").send({
      code, password: "password123", companyName: "Acme", timezone: "UTC",
    }).set("X-Forwarded-For", "127.0.0.1");
    console.log("SETUP", setupRes.status, setupRes.body);
    expect(setupRes.status).toBe(201);
    const cookie = setupRes.headers["set-cookie"]?.[0];
    expect(cookie).toContain("HttpOnly");
    const csrf = setupRes.body.csrfToken;

    // session GET
    const sessRes = await request(app).get("/api/v1/admin/session").set("Cookie", cookie);
    expect(sessRes.body.authenticated).toBe(true);
    expect(sessRes.body.setupRequired).toBe(false);

    // login? already session. Test CSRF rejection
    const noCsrf = await request(app).post("/api/v1/admin/pairings").set("Cookie", cookie).send({ label: "dev", role: "device" });
    expect(noCsrf.status).toBe(403);

    // create pairing
    const pairRes = await request(app).post("/api/v1/admin/pairings").set("Cookie", cookie).set("X-CSRF-Token", csrf).send({ label: "dev", role: "device", network: "lan", requireApproval: false });
    console.log("PAIR", pairRes.status, pairRes.body);
    expect(pairRes.status).toBe(201);
    const pairingId = pairRes.body.pairingId;
    const code2 = pairRes.body.code;
    const qrPayload = JSON.parse(pairRes.body.qrPayload);

    // claim
    const claimRes = await request(app).post("/api/v1/pair/claim").send({
      pairingId,
      code: code2,
      device: { name: "KASIR-1", platform: "android", appVersion: "1.0" },
    });
    console.log("CLAIM", claimRes.status, claimRes.body);
    expect(claimRes.status).toBe(201);
    expect(claimRes.body.token).toBeTruthy();

    // device token works
    const token = claimRes.body.token;
    const statusRes = await request(app).get("/api/v1/status").set("Authorization", `Bearer ${token}`);
    expect(statusRes.status).toBe(200);

    // revoked? not needed

    // public listener 404 admin
    const pubAdmin = await request(pub).get("/admin");
    expect(pubAdmin.status).toBe(404);
    const pubPair = await request(pub).get("/api/v1/admin/devices");
    expect(pubPair.status).toBe(404);

    // public healthz
    const pubHealth = await request(pub).get("/healthz");
    expect(pubHealth.status).toBe(200);

    // connectivity endpoint
    const connRes = await request(app).get("/api/v1/admin/connectivity").set("Cookie", cookie).set("X-CSRF-Token", csrf);
    expect(connRes.status).toBe(200);

    // diagnostics? not implemented endpoint maybe 404 okay

    ctx.cleanup();
  });
});
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeCtx } from "./helpers";
import { createAdminApp, createPublicApp } from "../src/app";
import { sha256Hex } from "../src/domain/hashing";

describe("appliance wan approval", () => {
  it("wan claim requires approval then second claim returns token", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const pub = createPublicApp(ctx) as any;
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now()+30*60*1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const setupRes = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
    const cookie = setupRes.headers["set-cookie"]?.[0];
    const csrf = setupRes.body.csrfToken;

    // config public url
    await request(app).put("/api/v1/admin/connectivity").set("Cookie", cookie).set("X-CSRF-Token", csrf).send({
      mode: "cloudflare", publicUrl: "https://abc.hub.example.com", publicPort: 8788,
    });

    const pairRes = await request(app).post("/api/v1/admin/pairings").set("Cookie", cookie).set("X-CSRF-Token", csrf).send({ label: "dev", role: "device", network: "wan" });
    expect(pairRes.status).toBe(201);
    const pairingId = pairRes.body.pairingId;
    const pcode = pairRes.body.code;

    // claim via public listener
    const claim1 = await request(pub).post("/api/v1/pair/claim").send({ pairingId, code: pcode, device: { name: "WANDEV" } });
    expect(claim1.status).toBe(202);
    expect(claim1.body.status).toBe("awaiting_approval");

    // approve
    const approve = await request(app).post(`/api/v1/admin/pairings/${pairingId}/approve`).set("Cookie", cookie).set("X-CSRF-Token", csrf);
    expect(approve.status).toBe(200);

    // claim again
    const claim2 = await request(pub).post("/api/v1/pair/claim").send({ pairingId, code: pcode, device: { name: "WANDEV" } });
    expect(claim2.status).toBe(201);
    expect(claim2.body.token).toBeTruthy();

    // admin 404 on public
    const admin404 = await request(pub).get("/api/v1/admin/devices");
    expect(admin404.status).toBe(404);

    ctx.cleanup();
  });
});
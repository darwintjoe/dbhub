import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeCtx } from "./helpers";
import { createAdminApp } from "../src/app";
import { sha256Hex } from "../src/domain/hashing";

describe("pairing secret at rest", () => {
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
    const pairRes = await request(app).post("/api/v1/admin/pairings").set("Cookie", cookie).set("X-CSRF-Token", csrf).send({ label: "dev", role: "device", network: "lan", requireApproval: false });
    return { app, cookie, csrf, pairRes };
  }

  it("does not persist plaintext secret in app_state", async () => {
    const ctx = makeCtx();
    const { pairRes } = await setup(ctx);
    const secret = JSON.parse(pairRes.body.qrPayload).secret;
    const rows = ctx.db.prepare("SELECT value FROM app_state").all() as { value: string }[];
    for (const r of rows) expect(r.value).not.toContain(secret);
    ctx.cleanup();
  });

  it("purges on claim", async () => {
    const ctx = makeCtx();
    const { app, pairRes } = await setup(ctx);
    const payload = JSON.parse(pairRes.body.qrPayload);
    const claimRes = await request(app).post("/api/v1/pair/claim").send({ pairingId: payload.pairingId, secret: payload.secret, device: { name: "D1" } });
    expect([201, 202]).toContain(claimRes.status);
    const secret = payload.secret;
    const rows = ctx.db.prepare("SELECT value FROM app_state").all() as { value: string }[];
    for (const r of rows) expect(r.value).not.toContain(secret);
    const enc = ctx.db.prepare("SELECT qr_payload_enc FROM pairing_sessions WHERE id=?").get(payload.pairingId) as { qr_payload_enc: string | null };
    expect(enc.qr_payload_enc).toBeNull();
    ctx.cleanup();
  });

  it("purges on delete", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf, pairRes } = await setup(ctx);
    const pairingId = pairRes.body.pairingId;
    const secret = JSON.parse(pairRes.body.qrPayload).secret;
    await request(app).delete("/api/v1/admin/pairings/" + pairingId).set("Cookie", cookie).set("X-CSRF-Token", csrf);
    const rows = ctx.db.prepare("SELECT value FROM app_state").all() as { value: string }[];
    for (const r of rows) expect(r.value).not.toContain(secret);
    ctx.cleanup();
  });

  it("purges on expiry", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf, pairRes } = await setup(ctx);
    const pairingId = pairRes.body.pairingId;
    const secret = JSON.parse(pairRes.body.qrPayload).secret;
    ctx.db.prepare("UPDATE pairing_sessions SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), pairingId);

    const qrRes = await request(app).get("/api/v1/admin/pairings/" + pairingId + "/qr.svg").set("Cookie", cookie).set("X-CSRF-Token", csrf);
    expect(qrRes.status).toBeGreaterThanOrEqual(400);
    expect(qrRes.status).toBeLessThan(500);
    let enc = ctx.db.prepare("SELECT qr_payload_enc FROM pairing_sessions WHERE id=?").get(pairingId) as { qr_payload_enc: string | null };
    expect(enc.qr_payload_enc).toBeNull();

    const claimRes = await request(app).post("/api/v1/pair/claim").send({ pairingId, secret, device: { name: "D3" } });
    expect(claimRes.status).toBe(400);
    expect(claimRes.body.error.code).toBe("PAIR-001");
    enc = ctx.db.prepare("SELECT qr_payload_enc FROM pairing_sessions WHERE id=?").get(pairingId) as { qr_payload_enc: string | null };
    expect(enc.qr_payload_enc).toBeNull();
    ctx.cleanup();
  });

  it("claim path purge on expiry", async () => {
    const ctx = makeCtx();
    const { app, pairRes } = await setup(ctx);
    const pairingId = pairRes.body.pairingId;
    const secret = JSON.parse(pairRes.body.qrPayload).secret;
    ctx.db.prepare("UPDATE pairing_sessions SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), pairingId);
    const claimRes = await request(app).post("/api/v1/pair/claim").send({ pairingId, secret, device: { name: "D4" } });
    expect(claimRes.status).toBe(400);
    const enc = ctx.db.prepare("SELECT qr_payload_enc FROM pairing_sessions WHERE id=?").get(pairingId) as { qr_payload_enc: string | null };
    expect(enc.qr_payload_enc).toBeNull();
    ctx.cleanup();
  });

  it("pairing create returns 503 when key material unavailable", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf } = await setup(ctx);
    const saved = process.env.DBHUB_APP_SECRET;
    delete process.env.DBHUB_APP_SECRET;
    ctx.config.dataDir = ctx.config.dataDir + "/missing-parent";
    try {
      const res = await request(app).post("/api/v1/admin/pairings").set("Cookie", cookie).set("X-CSRF-Token", csrf).send({ label: "dev", role: "device" });
      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain("Pairing key unavailable");
    } finally {
      if (saved !== undefined) process.env.DBHUB_APP_SECRET = saved;
    }
    ctx.cleanup();
  });

  it("qr fetch returns 503 when key material unavailable", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf, pairRes } = await setup(ctx);
    const pairingId = pairRes.body.pairingId;
    const saved = process.env.DBHUB_APP_SECRET;
    delete process.env.DBHUB_APP_SECRET;
    ctx.config.dataDir = ctx.config.dataDir + "/missing-parent";
    try {
      const res = await request(app).get("/api/v1/admin/pairings/" + pairingId + "/qr.svg").set("Cookie", cookie).set("X-CSRF-Token", csrf);
      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain("Pairing key unavailable");
    } finally {
      if (saved !== undefined) process.env.DBHUB_APP_SECRET = saved;
    }
    ctx.cleanup();
  });

  it("qr svg decodes to claim-capable payload", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf, pairRes } = await setup(ctx);
    const pairingId = pairRes.body.pairingId;
    const res = await request(app).get("/api/v1/admin/pairings/" + pairingId + "/qr.svg").set("Cookie", cookie).set("X-CSRF-Token", csrf);
    const svgText = Buffer.isBuffer(res.body) ? res.body.toString("utf8") : String(res.body);
    expect(res.status).toBe(200);
    const meta = svgText.match(/<metadata>(.*?)<\/metadata>/);
    expect(meta).toBeTruthy();
    const parsed = JSON.parse(meta![1].replace(/&quot;/g, "\""));
    const secret = parsed.secret;
    const claimRes = await request(app).post("/api/v1/pair/claim").send({ pairingId, secret, device: { name: "D2" } });
    expect([201, 202]).toContain(claimRes.status);
    ctx.cleanup();
  });

  it("purges and returns 410 when payload cannot be decrypted with the current key", async () => {
    const ctx = makeCtx();
    const { app, cookie, csrf, pairRes } = await setup(ctx);
    const pairingId = pairRes.body.pairingId;
    const row = ctx.db.prepare("SELECT qr_payload_enc FROM pairing_sessions WHERE id=?").get(pairingId) as { qr_payload_enc: string };
    const parts = row.qr_payload_enc.split(":");
    parts[1] = "deadbeef";
    ctx.db.prepare("UPDATE pairing_sessions SET qr_payload_enc=? WHERE id=?").run(parts.join(":"), pairingId);

    const res = await request(app)
      .get("/api/v1/admin/pairings/" + pairingId + "/qr.svg")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("PAIR-001");
    const after = ctx.db.prepare("SELECT qr_payload_enc FROM pairing_sessions WHERE id=?").get(pairingId) as { qr_payload_enc: string | null };
    expect(after.qr_payload_enc).toBeNull();
    ctx.cleanup();
  });
});
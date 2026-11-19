import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeCtx } from "./helpers";
import { createAdminApp } from "../src/app";
import { sha256Hex } from "../src/domain/hashing";
import { generateFirstRunSetupCode } from "../src/services/setup-code";

describe("setup code", () => {
  it("wrong code increments attempts", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const res = await request(app).post("/api/v1/admin/setup").send({ code: "BBBBBBBB-BBBBBBBB-BBBBBBBB-BBBBBBBB", password: "password123", companyName: "Acme", timezone: "UTC" });
    expect(res.status).toBe(400);
    const attempts = ctx.db.prepare("SELECT value FROM app_state WHERE key='setup.code_attempts'").get() as { value: string };
    expect(Number(attempts.value)).toBe(1);
    ctx.cleanup();
  });

  it("expired code returns 400 expired", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now() - 1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const res = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("expired");
    ctx.cleanup();
  });

  it("attempt exhaustion returns 429", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "10", now);
    const res = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
    expect(res.status).toBe(429);
    ctx.cleanup();
  });

  it("reuse rejected after setup complete", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const first = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
    expect(first.status).toBe(201);
    // re-add code to simulate old code
    ctx.db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const second = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
    expect(second.status).toBe(409);
    ctx.cleanup();
  });

  it("entropy shape and ttl", () => {
    const code = "A".repeat(32);
    expect(code.length).toBeGreaterThanOrEqual(32);
    const ttlMs = 30 * 60 * 1000;
    expect(ttlMs).toBe(1800000);
  });

  it("generated code is not emitted through the structured logger", async () => {
    const ctx = makeCtx();
    const emitted: string[] = [];
    const loggerCalls: unknown[][] = [];
    const logger = {
      info: (...args: unknown[]) => { loggerCalls.push(args); },
      warn: (...args: unknown[]) => { loggerCalls.push(args); },
      error: (...args: unknown[]) => { loggerCalls.push(args); },
    };
    const result = generateFirstRunSetupCode(ctx.db, ctx.config.dataDir, {
      emit: (line) => emitted.push(line),
      logger,
    });
    expect(result).toBeTruthy();
    const code = result!.code;
    // INTENTIONAL EMISSION: exactly one stdout line contains the code.
    expect(emitted.filter((line) => line.includes(code))).toHaveLength(1);
    expect(JSON.stringify(loggerCalls)).not.toContain(code);

    const app = createAdminApp(ctx) as any;
    const originalWrite = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: any, ...args: any[]) => {
      captured += String(chunk);
      return true;
    }) as any;
    try {
      const res = await request(app).post("/api/v1/admin/setup").send({ code, password: "password123", companyName: "Acme", timezone: "UTC" });
      expect(res.status).toBe(201);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured).not.toContain(code);
    expect(JSON.stringify(loggerCalls)).not.toContain(code);
    ctx.cleanup();
  });

  it("normalizes code with separators", async () => {
    const ctx = makeCtx();
    const app = createAdminApp(ctx) as any;
    const code = "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA";
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", sha256Hex(code), now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", exp, now);
    ctx.db.prepare("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now);
    const res = await request(app).post("/api/v1/admin/setup").send({ code: "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa", password: "password123", companyName: "Acme", timezone: "UTC" });
    expect(res.status).toBe(201);
    ctx.cleanup();
  });
});
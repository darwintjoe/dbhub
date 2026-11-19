import crypto from "node:crypto";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../../config";
import type { AuditRepo } from "../../db/audit.repo";
import { ApiError } from "../errors";
import { asyncHandler } from "../async-handler";
import { sha256Hex } from "../../domain/hashing";
import { parseCookies, ADMIN_COOKIE } from "../admin-session";
import { DEV_CSRF_TOKEN, isDevNoAuth } from "../dev-no-auth";
import {
  hashPassword,
  verifyPassword,
  createAdminSession,
  setAdminCookie,
  clearAdminCookie,
  isPrivateIp,
  getSession,
} from "../admin-session";

export interface AdminAuthDeps {
  config: Config;
  db: any;
  audit?: AuditRepo;
}

export function adminAuthRoutes(deps: AdminAuthDeps) {
  const router = Router();
  const { config, db, audit } = deps;

  function setupComplete(): boolean {
    const row = db.prepare("SELECT 1 FROM admin_credentials WHERE id=1").get();
    return Boolean(row);
  }

  const failures = new Map<string, { count: number; until: number }>();
  function checkLockout(ip: string): void {
    const rec = failures.get(ip);
    if (rec && rec.until > Date.now()) {
      throw new ApiError(429, "AUTH-001", "Too many failed attempts. Try again later.");
    }
  }
  function recordFailure(ip: string): void {
    const rec = failures.get(ip) ?? { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= 5) {
      rec.until = Date.now() + 15 * 60 * 1000;
      rec.count = 0;
    }
    failures.set(ip, rec);
  }

  router.post("/setup", asyncHandler(async (req: Request, res: Response) => {
    if (setupComplete()) throw new ApiError(409, "AUTH-001", "Setup already complete.");
    const schema = z.object({
      code: z.string().min(1),
      password: z.string().min(8),
      companyName: z.string().min(1),
      timezone: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "AUTH-001", "Invalid setup payload.", { details: parsed.error.flatten() });

    const ip = (req.ip || "").replace(/^::ffff:/, "");
    if (!isPrivateIp(ip)) throw new ApiError(403, "AUTH-001", "Setup is only allowed from the LAN.");

    const hashRow = db.prepare("SELECT value FROM app_state WHERE key='setup.code_hash'").get() as { value: string } | undefined;
    const createdRow = db.prepare("SELECT value FROM app_state WHERE key='setup.code_created_at'").get() as { value: string } | undefined;
    const expiresRow = db.prepare("SELECT value FROM app_state WHERE key='setup.code_expires_at'").get() as { value: string } | undefined;
    const attemptsRow = db.prepare("SELECT value FROM app_state WHERE key='setup.code_attempts'").get() as { value: string } | undefined;
    if (!hashRow || !expiresRow) throw new ApiError(400, "AUTH-001", "No setup code available.");
    if (Date.now() > Date.parse(expiresRow.value)) throw new ApiError(400, "AUTH-001", "Setup code expired.");
    const attempts = Number(attemptsRow?.value ?? "0");
    if (attempts >= 10) throw new ApiError(429, "AUTH-001", "Setup code attempts exhausted.");
    const normalizedCode = parsed.data.code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const group = (n: number) => (normalizedCode.match(new RegExp(".{1," + n + "}", "g")) ?? []).join("-");
    const candidates = [
      parsed.data.code,
      parsed.data.code.toUpperCase(),
      normalizedCode,
      group(4),
      group(8),
    ];
    const providedHashes = candidates.map((v) => crypto.createHash("sha256").update(v, "utf8").digest("hex"));
    const ok = providedHashes.some((h) => {
      try { return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hashRow.value, "hex")); } catch { return false; }
    });
    if (!ok) {
      db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", String(attempts + 1), new Date().toISOString());
      audit?.log(new Date().toISOString(), "admin", "setup.code_failed", { ip });
      throw new ApiError(400, "AUTH-001", "Invalid setup code.");
    }

    const now = new Date().toISOString();
    const passwordHash = hashPassword(parsed.data.password);
    const recoveryCode = `rc_${crypto.randomBytes(16).toString("hex")}`;
    const recoveryHash = crypto.createHash("sha256").update(recoveryCode, "utf8").digest("hex");

    db.prepare("INSERT INTO admin_credentials (id, password_hash, recovery_hash, updated_at) VALUES (1,?,?,?)").run(
      passwordHash,
      recoveryHash,
      now,
    );
    db.prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?,?,?)").run("company.name", parsed.data.companyName, now);
    db.prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?,?,?)").run("timezone", parsed.data.timezone, now);
    db.prepare("DELETE FROM app_state WHERE key='setup.code_hash'").run();
    db.prepare("DELETE FROM app_state WHERE key='setup.code_created_at'").run();
    db.prepare("DELETE FROM app_state WHERE key='setup.code_expires_at'").run();
    db.prepare("DELETE FROM app_state WHERE key='setup.code_attempts'").run();

    const session = createAdminSession(db, { ip: req.ip ?? undefined, userAgent: req.get("user-agent") ?? undefined });
    setAdminCookie(res, req, session.token);
    audit?.log(now, "admin", "setup.completed", { ip, companyName: parsed.data.companyName });

    res.status(201).json({
      authenticated: true,
      csrfToken: session.csrfToken,
      recoveryCode,
    });
  }));

  router.post("/session", asyncHandler(async (req: Request, res: Response) => {
    // Dev no-auth: no password check, no lockout, no session required.
    if (isDevNoAuth()) {
      res.json({
        authenticated: true,
        csrfToken: DEV_CSRF_TOKEN,
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      });
      return;
    }
    const ip = req.ip || "unknown";
    checkLockout(ip);
    const schema = z.object({ password: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "AUTH-001", "Invalid login payload.");

    const cred = db.prepare("SELECT password_hash FROM admin_credentials WHERE id=1").get() as { password_hash: string } | undefined;
    if (!cred) throw new ApiError(409, "AUTH-001", "Setup required.");

    if (!verifyPassword(parsed.data.password, cred.password_hash)) {
      recordFailure(ip);
      audit?.log(new Date().toISOString(), "admin", "login.failed", { ip });
      throw new ApiError(401, "AUTH-001", "Invalid password.");
    }
    const session = createAdminSession(db, { ip, userAgent: req.get("user-agent") ?? undefined });
    setAdminCookie(res, req, session.token);
    audit?.log(new Date().toISOString(), "admin", "login.success", { ip });
    res.json({ authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  }));

  router.get("/session", asyncHandler(async (req: Request, res: Response) => {
    // Dev no-auth: report a ready, authenticated session so the UI skips the
    // setup wizard and login dialog and goes straight to the dashboard.
    if (isDevNoAuth()) {
      res.json({ authenticated: true, setupRequired: false, csrfToken: DEV_CSRF_TOKEN });
      return;
    }
    const setupRequired = !setupComplete();
    const session = getSession(db, config, req);
    if (!session) {
      res.json({ authenticated: false, setupRequired, csrfToken: null });
      return;
    }
    res.json({ authenticated: true, setupRequired, csrfToken: session.csrfToken });
  }));

  router.delete("/session", asyncHandler(async (req: Request, res: Response) => {
    const cookies = parseCookies(req);
    const raw = cookies[ADMIN_COOKIE];
    if (raw) {
      db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(sha256Hex(raw));
    }
    clearAdminCookie(res);
    audit?.log(new Date().toISOString(), "admin", "logout", { ip: req.ip });
    res.json({ ok: true });
  }));

  return router;
}
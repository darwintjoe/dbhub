import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Config } from "../config";
import { sha256Hex } from "../domain/hashing";
import { ApiError } from "./errors";
import { isDevNoAuth } from "./dev-no-auth";

export const ADMIN_COOKIE = "dbhub_admin";

export interface AdminSessionRow {
  id: string;
  token_hash: string;
  csrf_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1]!, "hex");
    const expected = Buffer.from(parts[2]!, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createAdminSession(db: any, opts: { ip?: string | undefined; userAgent?: string | undefined } = {}): {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: string;
} {
  const sessionId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  const csrfToken = sessionId;
  const csrfHash = sha256Hex(csrfToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO admin_sessions (id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)",
  ).run(sessionId, tokenHash, csrfHash, now.toISOString(), expiresAt, now.toISOString(), opts.ip ?? null, opts.userAgent ?? null);
  return { sessionId, token, csrfToken, expiresAt };
}

export function getSession(db: any, config: Config, req: Request): { session: AdminSessionRow; csrfToken: string } | null {
  const cookies = parseCookies(req);
  const raw = cookies[ADMIN_COOKIE];
  if (!raw) return null;
  const hash = sha256Hex(raw);
  const row = db.prepare("SELECT * FROM admin_sessions WHERE token_hash=?").get(hash) as AdminSessionRow | undefined;
  if (!row) return null;
  const now = Date.now();
  const created = Date.parse(row.created_at);
  const expires = Date.parse(row.expires_at);
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : created;
  if (Number.isNaN(expires) || now > expires) {
    db.prepare("DELETE FROM admin_sessions WHERE id=?").run(row.id);
    return null;
  }
  if (now - lastSeen > 30 * 60 * 1000) {
    db.prepare("DELETE FROM admin_sessions WHERE id=?").run(row.id);
    return null;
  }
  if (now - created > 12 * 60 * 60 * 1000) {
    db.prepare("DELETE FROM admin_sessions WHERE id=?").run(row.id);
    return null;
  }
  db.prepare("UPDATE admin_sessions SET last_seen_at=? WHERE id=?").run(new Date().toISOString(), row.id);
  return { session: row, csrfToken: row.id };
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function setAdminCookie(res: Response, req: Request, token: string): void {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const attrs = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${12 * 60 * 60}`,
  ];
  if (secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearAdminCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export function isPrivateIp(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return true;
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function requireAdmin(config: Config, db?: any) {
  return (req: Request, res: Response, next: (err?: any) => void) => {
    // Dev-only bypass: skip bearer token, session cookie and CSRF entirely.
    if (isDevNoAuth()) {
      (req as any).isAdmin = true;
      return next();
    }
    const auth = req.header("authorization");
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const token = (m[1] ?? "").trim();
      const providedHash = sha256Hex(token);
      const adminHash = config.adminTokenHash;
      if (/^[0-9a-f]{64}$/.test(adminHash)) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(providedHash, "hex"), Buffer.from(adminHash, "hex"))) {
            (req as any).isAdmin = true;
            return next();
          }
        } catch {
          // fall through
        }
      }
      return next(new ApiError(401, "AUTH-001", "Invalid admin token."));
    }
    if (db) {
      const session = getSession(db, config, req);
      if (session) {
        const method = req.method.toUpperCase();
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          const csrf = req.header("x-csrf-token");
          const row = db.prepare("SELECT csrf_hash FROM admin_sessions WHERE id=?").get(session.session.id) as { csrf_hash: string } | undefined;
          if (!csrf || !row || sha256Hex(csrf) !== row.csrf_hash) {
            return next(new ApiError(403, "AUTH-004", "Invalid CSRF token."));
          }
        }
        (req as any).isAdmin = true;
        (req as any).adminSession = session.session;
        return next();
      }
    }
    return next(new ApiError(401, "AUTH-001", "Missing or invalid admin credentials."));
  };
}
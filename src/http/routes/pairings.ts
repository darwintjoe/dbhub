import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import type { Config } from "../../config";
import type { DevicesRepo } from "../../db/devices.repo";
import type { AuditRepo } from "../../db/audit.repo";
import { ApiError } from "../errors";
import { asyncHandler } from "../async-handler";
import { resolveEndpoints } from "../../services/endpoints";

export interface PairingsDeps {
  config: Config;
  db: any;
  devices: DevicesRepo;
  audit?: AuditRepo;
  serial?: string;
  mdnsHost?: string;
  isPublicListener?: boolean;
}

const DEFAULT_SCOPES = ["relay:write", "pull:read", "manifest:read"];

let keyFailureLogged = false;

function logKeyFailureOnce(reason: string): void {
  if (keyFailureLogged) return;
  keyFailureLogged = true;
  console.error("DBHub pairing key unavailable: " + reason);
}

interface PairingKey { key: Buffer; kid: string }

function getPairingKey(config: any): PairingKey {
  const envSecret = process.env.DBHUB_APP_SECRET;
  let key: Buffer;
  if (envSecret) {
    key = crypto.createHash("sha256").update(envSecret, "utf8").digest();
  } else {
    const keyPath = path.join(config.dataDir || "", "pairing.key");
    try {
      if (!fs.existsSync(keyPath)) {
        const fresh = crypto.randomBytes(32);
        try {
          fs.writeFileSync(keyPath, fresh, { mode: 0o600, flag: "wx" });
          key = fresh;
        } catch (e: any) {
          if (e?.code === "EEXIST") {
            key = fs.readFileSync(keyPath);
          } else {
            throw e;
          }
        }
      } else {
        key = fs.readFileSync(keyPath);
      }
      if (key.length !== 32) throw new Error("key file is not 32 bytes");
    } catch {
      logKeyFailureOnce("unable to read or create the dedicated pairing key file");
      throw new ApiError(503, "PAIR-001", "Pairing key unavailable. Set DBHUB_APP_SECRET or create a 32-byte key file at " + keyPath + ".");
    }
  }
  const kid = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return { key, kid };
}

function encryptPayload(config: any, payload: string): string {
  const { key, kid } = getPairingKey(config);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", kid, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

function decryptPayload(config: any, blob: string | null): string | null {
  if (!blob) return null;
  const parts = blob.split(":");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const { key, kid } = getPairingKey(config);
  if (parts[1] !== kid) return null;
  try {
    if (!parts[2] || !parts[3] || !parts[4]) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64"));
    decipher.setAuthTag(Buffer.from(parts[3], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function purgePairingPayload(db: any, id: string): void {
  db.prepare("UPDATE pairing_sessions SET qr_payload_enc=NULL WHERE id=?").run(id);
  db.prepare("DELETE FROM app_state WHERE key=?").run("pairing." + id + ".qrPayload");
}

function nowIso(): string {
  return new Date().toISOString();
}

function genCode(): string {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

function genSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function hash(v: string): string {
  return crypto.createHash("sha256").update(v, "utf8").digest("hex");
}

function endpointsFor(config: Config, serial: string, mdnsHost: string) {
  const resolved = resolveEndpoints(config, serial, mdnsHost);
  return {
    lan: resolved.lan,
    mdns: resolved.mdns,
    wan: resolved.wan,
    all: resolved.all,
  };
}

export function pairingsAdminRoutes(deps: PairingsDeps) {
  const router = Router();
  const { config, db, devices, audit } = deps;
  const serial = deps.serial ?? config.replicaId;
  const mdnsHost = deps.mdnsHost ?? `dbhub-${serial}.local`;

  router.post("/", asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      label: z.string().min(1),
      role: z.string().min(1).default("device"),
      scopes: z.array(z.string()).optional(),
      network: z.enum(["lan", "wan"]).default("lan"),
      requireApproval: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, "PAIR-001", "Invalid pairing payload.", { details: parsed.error.flatten() });

    const id = crypto.randomUUID();
    const code = genCode();
    const qrSecret = genSecret();
    const scopes = parsed.data.scopes?.length ? parsed.data.scopes : DEFAULT_SCOPES;
    const requireApproval = parsed.data.requireApproval ?? (parsed.data.network === "wan" ? true : false);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO pairing_sessions (id, code_hash, qr_secret_hash, label, role, scopes_json, status, attempts, require_approval, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      hash(code),
      hash(qrSecret),
      parsed.data.label,
      parsed.data.role,
      JSON.stringify(scopes),
      "pending",
      0,
      requireApproval ? 1 : 0,
      createdAt,
      expiresAt,
    );

    audit?.log(createdAt, "admin", "pairing.created", { pairingId: id, label: parsed.data.label, network: parsed.data.network });

    const ep = endpointsFor(config, serial, mdnsHost);
    const qrPayload = JSON.stringify({ v: 1, pairingId: id, secret: qrSecret, hub: ep.lan[0]?.url ?? `http://localhost:${config.port}` });
    const enc = encryptPayload(config, qrPayload);
    db.prepare("UPDATE pairing_sessions SET qr_payload_enc=? WHERE id=?").run(enc, id);

    res.status(201).json({
      pairingId: id,
      code,
      qrPayload,
      expiresAt,
      endpoints: ep,
    });
  }));

  router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare("SELECT * FROM pairing_sessions WHERE id=?").get(id) as any;
    if (!row) throw new ApiError(404, "PAIR-001", "Pairing not found.");
    res.json({
      pairingId: row.id,
      status: row.status,
      label: row.label,
      role: row.role,
      scopes: JSON.parse(row.scopes_json),
      attempts: row.attempts,
      requireApproval: Boolean(row.require_approval),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at,
      approvedAt: row.approved_at,
      deviceId: row.device_id,
    });
  }));

  router.post("/:id/approve", asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare("SELECT * FROM pairing_sessions WHERE id=?").get(id) as any;
    if (!row) throw new ApiError(404, "PAIR-001", "Pairing not found.");
    if (row.status !== "awaiting_approval" && row.status !== "pending") {
      throw new ApiError(409, "PAIR-001", "Pairing is not awaiting approval.");
    }
    const now = nowIso();
    db.prepare("UPDATE pairing_sessions SET status='approved', approved_at=? WHERE id=?").run(now, id);
    audit?.log(now, "admin", "pairing.approved", { pairingId: id });
    res.json({ ok: true, pairingId: id, status: "approved" });
  }));

  router.delete("/:id", asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare("SELECT * FROM pairing_sessions WHERE id=?").get(id) as any;
    if (!row) throw new ApiError(404, "PAIR-001", "Pairing not found.");
    db.prepare("UPDATE pairing_sessions SET status='revoked' WHERE id=?").run(id);
    purgePairingPayload(db, id);
    audit?.log(nowIso(), "admin", "pairing.revoked", { pairingId: id });
    res.json({ ok: true });
  }));

  router.get("/:id/qr.svg", asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = db.prepare("SELECT qr_payload_enc, expires_at, status FROM pairing_sessions WHERE id=?").get(id) as any;
    if (!row) throw new ApiError(404, "PAIR-001", "Pairing not found.");
    if (Date.now() > Date.parse(row.expires_at)) {
      db.prepare("UPDATE pairing_sessions SET status='expired' WHERE id=?").run(id);
      purgePairingPayload(db, id);
      throw new ApiError(410, "PAIR-001", "Pairing expired.");
    }
    const payload = decryptPayload(config, row.qr_payload_enc);
    if (!payload) {
      purgePairingPayload(db, id);
      throw new ApiError(410, "PAIR-001", "Pairing expired.");
    }
    const svg = await QRCode.toString(payload, { type: "svg" });
    const escaped = payload.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const annotated = svg.replace("</svg>", `<metadata>${escaped}</metadata></svg>`);
    res.type("image/svg+xml").send(annotated);
  }));

  return router;
}

export function pairClaimRoute(deps: PairingsDeps) {
  const router = Router();
  const { config, db, devices, audit } = deps;
  const serial = deps.serial ?? config.replicaId;
  const mdnsHost = deps.mdnsHost ?? `dbhub-${serial}.local`;
  const isPublic = Boolean(deps.isPublicListener);

  router.post("/claim", asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      pairingId: z.string().min(1),
      code: z.string().min(1).optional(),
      secret: z.string().min(1).optional(),
      device: z.object({
        name: z.string().min(1),
        platform: z.string().optional(),
        appVersion: z.string().optional(),
        publicKey: z.string().optional(),
      }),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "PAIR-001", "Invalid claim payload.", { details: parsed.error.flatten() });
    if (!parsed.data.code && !parsed.data.secret) throw new ApiError(400, "PAIR-001", "code or secret required.");

    const { pairingId, device } = parsed.data;
    const code = parsed.data.code ?? parsed.data.secret!;
    const row = db.prepare("SELECT * FROM pairing_sessions WHERE id=?").get(pairingId) as any;
    if (!row) throw new ApiError(404, "PAIR-001", "Pairing not found.");

    if (Date.now() > Date.parse(row.expires_at)) {
      db.prepare("UPDATE pairing_sessions SET status='expired' WHERE id=?").run(pairingId);
      purgePairingPayload(db, pairingId);
      throw new ApiError(400, "PAIR-001", "Pairing expired.");
    }
    if (row.status === "revoked" || row.status === "expired" || row.status === "claimed") {
      throw new ApiError(410, "PAIR-001", "Pairing is no longer valid.");
    }
    if (row.attempts >= 5) {
      throw new ApiError(429, "PAIR-001", "Too many attempts.");
    }

    const providedHash = hash(code);
    let codeOk = false;
    let secretOk = false;
    try {
      codeOk = crypto.timingSafeEqual(Buffer.from(providedHash, "hex"), Buffer.from(row.code_hash, "hex"));
    } catch { /* ignore */ }
    if (row.qr_secret_hash) {
      try {
        secretOk = crypto.timingSafeEqual(Buffer.from(providedHash, "hex"), Buffer.from(row.qr_secret_hash, "hex"));
      } catch { /* ignore */ }
    }
    if (!codeOk && !secretOk) {
      db.prepare("UPDATE pairing_sessions SET attempts=attempts+1 WHERE id=?").run(pairingId);
      throw new ApiError(400, "PAIR-001", "Invalid pairing code.");
    }

    let requireApproval = Boolean(row.require_approval);
    if (isPublic) requireApproval = true;

    const deviceInfo = JSON.stringify({
      name: device.name,
      platform: device.platform ?? null,
      appVersion: device.appVersion ?? null,
      publicKey: device.publicKey ?? null,
    });
    db.prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?,?,?)").run(
      `pairing.${pairingId}.device`,
      deviceInfo,
      nowIso(),
    );

    if (row.status === "approved") {
      return createDeviceFromPairing(config, db, devices, audit, row, device, res);
    }

    if (requireApproval) {
      db.prepare("UPDATE pairing_sessions SET status='awaiting_approval', claimed_at=? WHERE id=?").run(nowIso(), pairingId);
      audit?.log(nowIso(), "device", "pairing.claim.pending", { pairingId });
      res.status(202).json({ status: "awaiting_approval", pairingId });
      return;
    }

    db.prepare("UPDATE pairing_sessions SET status='approved', approved_at=? WHERE id=?").run(nowIso(), pairingId);
    return createDeviceFromPairing(config, db, devices, audit, row, device, res);
  }));

  return router;
}

function createDeviceFromPairing(
  config: Config,
  db: any,
  devices: DevicesRepo,
  audit: AuditRepo | undefined,
  row: any,
  device: { name: string; platform?: string | undefined; appVersion?: string | undefined; publicKey?: string | undefined },
  res: Response,
) {
  if (row.device_id) {
    throw new ApiError(409, "PAIR-001", "Pairing already claimed.");
  }
  const id = `dev_${crypto.randomUUID()}`;
  const token = `fzh_${crypto.randomBytes(32).toString("base64url")}`;
  const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const scopes = JSON.parse(row.scopes_json) as string[];
  const now = nowIso();
  const dev: any = {
    id,
    companyId: config.companyId,
    prefix: (device.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "DEV"),
    label: device.name,
    tokenHash,
    status: "approved",
    createdAt: now,
    lastSeenAt: null,
    scopes,
    platform: device.platform ?? null,
    appVersion: device.appVersion ?? null,
    pairedAt: now,
    publicKey: device.publicKey ?? null,
  };
  const created = devices.createWithRetry(dev, false);
  if (!created.ok) {
    // retry with suggested prefix
    dev.prefix = devices.suggestPrefix(config.companyId);
    const retry = devices.createWithRetry({ ...dev, prefix: dev.prefix }, false);
    if (!retry.ok) throw new ApiError(409, "DEVICE-001", "Unable to allocate device prefix.");
  }
  db.prepare("UPDATE pairing_sessions SET status='claimed', claimed_at=?, device_id=? WHERE id=?").run(now, id, row.id);

  const serial = config.replicaId;
  const mdnsHost = `dbhub-${serial}.local`;
  const ep = resolveEndpoints(config, serial, mdnsHost);
  purgePairingPayload(db, row.id);
  audit?.log(now, "admin", "device.paired", { deviceId: id, pairingId: row.id });

  res.status(201).json({
    deviceId: id,
    token,
    hub: ep.lan[0]?.url ?? `http://localhost:${config.port}`,
    endpoints: ep,
    tlsFingerprint: null,
  });
}
import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { Router } from "express";
import type { Config } from "../../config";
import type { DevicesRepo } from "../../db/devices.repo";
import type { AuditRepo } from "../../db/audit.repo";
import { sha256Hex } from "../../domain/hashing";
import { ApiError } from "../errors";
import { resolveEndpoints } from "../../services/endpoints";

const createSchema = z.object({
  label: z.string().min(1),
  prefix: z.string().min(1).optional(),
});

export function devicesRoutes(config: Config, devices: DevicesRepo, audit: AuditRepo, bundles?: any) {
  const router = Router();

  router.post("/", (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "BUNDLE-001", "Malformed request body.", { details: parsed.error.flatten() });
    const explicit = parsed.data.prefix !== undefined;
    const prefix = parsed.data.prefix ?? devices.suggestPrefix(config.companyId);
    const id = `dev_${randomUUID()}`;
    const token = `fzh_${randomBytes(32).toString("base64url")}`;
    const tokenH = sha256Hex(token);
    const now = new Date().toISOString();
    const created = devices.createWithRetry(
      {
        id,
        companyId: config.companyId,
        prefix,
        label: parsed.data.label,
        tokenHash: tokenH,
        status: "approved",
        createdAt: now,
        lastSeenAt: null,
      },
      explicit,
    );
    if (!created.ok) {
      throw new ApiError(409, "BUNDLE-006", "Prefix already in use.");
    }
    audit.log(now, "admin", "device.created", { deviceId: id, prefix: created.prefix });
    const serial = config.replicaId;
    const mdnsHost = `dbhub-${serial}.local`;
    const endpoints = resolveEndpoints(config, serial, mdnsHost);
    const hubUrl = endpoints.lan[0]?.url ?? endpoints.preferred;
    res.status(201).json({ deviceId: id, prefix: created.prefix, token, hubUrl, endpoints });
  });

  router.get("/", (_req: Request, res: Response) => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const list = devices.list(config.companyId).map((d) => ({
      id: d.id,
      prefix: d.prefix,
      label: d.label,
      status: d.status,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      online: Boolean(d.lastSeenAt && Date.parse(d.lastSeenAt) >= cutoff),
      accepted: bundles?.countByDeviceAndStatus ? bundles.countByDeviceAndStatus(d.id, "accepted") : 0,
      pending: bundles?.countByDeviceAndStatus ? bundles.countByDeviceAndStatus(d.id, "pending_parent") : 0,
      quarantined: bundles?.countByDeviceAndStatus ? bundles.countByDeviceAndStatus(d.id, "quarantined") : 0,
    }));
    res.json({ devices: list });
  });

  router.patch("/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = devices.findById(id);
    if (!d) throw new ApiError(404, "BUNDLE-001", "Device not found.");
    const parsed = z.object({ label: z.string().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "CONFIG-001", "Invalid label.", { details: parsed.error.flatten() });
    devices.updateLabel(id, parsed.data.label);
    audit.log(new Date().toISOString(), "admin", "device.label-updated", { deviceId: id, label: parsed.data.label });
    res.json({ ok: true });
  });

  router.post("/:id/rotate-token", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = devices.findById(id);
    if (!d) throw new ApiError(404, "BUNDLE-001", "Device not found.");
    if (d.status !== "approved") throw new ApiError(409, "BUNDLE-006", "Device is revoked.");
    const token = `fzh_${randomBytes(32).toString("base64url")}`;
    devices.updateTokenHash(id, sha256Hex(token));
    audit.log(new Date().toISOString(), "admin", "device.token-rotated", { deviceId: id });
    const serial = config.replicaId;
    const mdnsHost = `dbhub-${serial}.local`;
    const endpoints = resolveEndpoints(config, serial, mdnsHost);
    const hubUrl = endpoints.lan[0]?.url ?? endpoints.preferred;
    res.json({ deviceId: id, token, hubUrl, endpoints });
  });

  router.post("/:id/revoke", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = devices.findById(id);
    if (!d) throw new ApiError(404, "BUNDLE-001", "Device not found.");
    devices.revoke(id);
    audit.log(new Date().toISOString(), "admin", "device.revoked", { deviceId: id });
    res.json({ ok: true });
  });

  return router;
}

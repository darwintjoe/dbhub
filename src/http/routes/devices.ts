import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { Router } from "express";
import type { Config } from "../../config";
import type { DevicesRepo } from "../../db/devices.repo";
import type { AuditRepo } from "../../db/audit.repo";
import { sha256Hex } from "../../domain/hashing";
import { ApiError } from "../errors";

const createSchema = z.object({
  label: z.string().min(1),
  prefix: z.string().min(1).optional(),
});

export function devicesRoutes(config: Config, devices: DevicesRepo, audit: AuditRepo) {
  const router = Router();

  router.post("/", (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "BUNDLE-001", "Malformed request body.", { details: parsed.error.flatten() });
    const prefix = parsed.data.prefix ?? devices.suggestPrefix(config.companyId);
    // ensure uniqueness
    const id = `dev_${randomUUID()}`;
    const token = `fzh_${randomBytes(32).toString("base64url")}`;
    const tokenH = sha256Hex(token);
    const now = new Date().toISOString();
    devices.create({
      id,
      companyId: config.companyId,
      prefix,
      label: parsed.data.label,
      tokenHash: tokenH,
      status: "approved",
      createdAt: now,
      lastSeenAt: null,
    });
    audit.log(now, "admin", "device.created", { deviceId: id, prefix });
    const hubUrl = `http://${req.get("host") ?? `localhost:${config.port}`}`;
    res.status(201).json({ deviceId: id, prefix, token, hubUrl });
  });

  router.get("/", (_req: Request, res: Response) => {
    const list = devices.list(config.companyId).map((d) => ({
      id: d.id,
      prefix: d.prefix,
      label: d.label,
      status: d.status,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
    }));
    res.json({ devices: list });
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

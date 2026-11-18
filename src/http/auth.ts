import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config";
import type { DevicesRepo } from "../db/devices.repo";
import { sha256Hex } from "../domain/hashing";
import { ApiError } from "./errors";

export interface AuthedRequest extends Request {
  device?: { id: string; companyId: string; prefix: string; label: string; status: string };
  isAdmin?: boolean;
}

function bearer(req: Request): string | null {
  const h = req.header("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] ?? "").trim() : null;
}

export function requireAdmin(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return next(new ApiError(401, "AUTH-001", "Missing bearer token."));
    const providedHash = sha256Hex(token);
    const a = Buffer.from(providedHash, "hex");
    const b = Buffer.from(config.adminTokenHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return next(new ApiError(401, "AUTH-001", "Invalid admin token."));
    }
    (req as AuthedRequest).isAdmin = true;
    next();
  };
}

export function requireDevice(devices: DevicesRepo) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return next(new ApiError(401, "AUTH-001", "Missing bearer token."));
    const hash = sha256Hex(token);
    const device = devices.findByTokenHash(hash);
    if (!device) return next(new ApiError(401, "AUTH-001", "Invalid device token."));
    if (device.status !== "approved") return next(new ApiError(403, "AUTH-002", "Device revoked."));
    (req as AuthedRequest).device = {
      id: device.id,
      companyId: device.companyId,
      prefix: device.prefix,
      label: device.label,
      status: device.status,
    };
    next();
  };
}

export function requireDeviceOrAdmin(config: Config, devices: DevicesRepo) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return next(new ApiError(401, "AUTH-001", "Missing bearer token."));
    const hash = sha256Hex(token);
    const adminBuf = Buffer.from(config.adminTokenHash, "hex");
    const providedBuf = Buffer.from(hash, "hex");
    if (providedBuf.length === adminBuf.length && timingSafeEqual(providedBuf, adminBuf)) {
      (req as AuthedRequest).isAdmin = true;
      return next();
    }
    const device = devices.findByTokenHash(hash);
    if (!device) return next(new ApiError(401, "AUTH-001", "Invalid token."));
    if (device.status !== "approved") return next(new ApiError(403, "AUTH-002", "Device revoked."));
    (req as AuthedRequest).device = {
      id: device.id,
      companyId: device.companyId,
      prefix: device.prefix,
      label: device.label,
      status: device.status,
    };
    next();
  };
}

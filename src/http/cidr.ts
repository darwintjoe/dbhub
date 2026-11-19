import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config";
import { ApiError } from "./errors";

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  if (cidr.includes("/")) {
    const [net, bitsStr] = cidr.split("/");
    const bits = Number(bitsStr);
    const ipN = ipToInt(ip);
    const netN = net ? ipToInt(net) : null;
    if (ipN == null || netN == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipN & mask) === (netN & mask);
  }
  return ip === cidr;
}

export function adminCidrMiddleware(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const cidrs = (config as any)?.security?.adminAllowedCidrs;
    if (!Array.isArray(cidrs) || cidrs.length === 0) return next();
    const ip = (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
    // IPv6 exact/loopback acceptable
    for (const c of cidrs) {
      if (typeof c !== "string") continue;
      if (c.includes(":")) {
        if (ip === c || (c === "::1" && ip === "::1")) return next();
        continue;
      }
      if (inCidr(ip, c)) return next();
    }
    return next(new ApiError(403, "AUTH-003", "Admin access denied by CIDR allowlist."));
  };
}

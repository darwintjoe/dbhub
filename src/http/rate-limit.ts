import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config";
import { sha256Hex } from "../domain/hashing";
import { ApiError } from "./errors";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export function rateLimitMiddleware(config: Config) {
  const buckets = new Map<string, Bucket>();
  const capacityDevice = config.limits.ratePerMinutePerDevice;
  const capacityIp = config.limits.ratePerMinutePerIp;

  function consume(key: string, capacity: number): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, lastRefill: now };
      buckets.set(key, b);
    }
    const elapsed = (now - b.lastRefill) / 1000;
    const refill = (elapsed / 60) * capacity;
    b.tokens = Math.min(capacity, b.tokens + refill);
    b.lastRefill = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    const retryAfter = Math.ceil(((1 - b.tokens) / capacity) * 60);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const ipResult = consume(`ip:${ip}`, capacityIp);
    if (!ipResult.ok) {
      res.setHeader("Retry-After", String(ipResult.retryAfter));
      return next(new ApiError(429, "RATE-001", "Rate limited."));
    }
    const auth = req.header("authorization");
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const key = `dev:${sha256Hex((m[1] ?? "").trim())}`;
      const devResult = consume(key, capacityDevice);
      if (!devResult.ok) {
        res.setHeader("Retry-After", String(devResult.retryAfter));
        return next(new ApiError(429, "RATE-001", "Rate limited."));
      }
    }
    next();
  };
}

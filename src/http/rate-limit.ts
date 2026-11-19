import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config";
import { sha256Hex } from "../domain/hashing";
import { ApiError } from "./errors";
import { timingSafeEqual } from "node:crypto";

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  bucketCount(): number;
}

const IDLE_EVICTION_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 10_000;

interface Bucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
}

function readLimits(config: Config) {
  const limits = (config as { limits?: Record<string, unknown> }).limits ?? {};
  return {
    device: Number(limits.ratePerMinutePerDevice ?? 120) || 120,
    ip: Number(limits.ratePerMinutePerIp ?? 300) || 300,
    admin: Number(limits.ratePerMinutePerAdmin ?? 600) || 600,
  };
}

function isAdminToken(config: Config, token: string): boolean {
  const hash = sha256Hex(token);
  const adminHash = (config as { adminTokenHash?: string }).adminTokenHash;
  if (!adminHash || !/^[0-9a-f]{64}$/.test(adminHash)) return false;
  try {
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(adminHash, "hex"));
  } catch {
    return false;
  }
}

export function rateLimitMiddleware(config: Config): RateLimiter {
  const buckets = new Map<string, Bucket>();

  function evictIdle(now: number): void {
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > IDLE_EVICTION_MS) buckets.delete(key);
    }
    while (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  function consume(key: string, capacity: number): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, lastRefill: now, capacity };
      buckets.set(key, b);
    }
    if (b.capacity !== capacity) {
      b.tokens = Math.min(b.tokens, capacity);
      b.capacity = capacity;
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

  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    evictIdle(Date.now());
    const limits = readLimits(config);
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const ipResult = consume(`ip:${ip}`, limits.ip);
    if (!ipResult.ok) {
      res.setHeader("Retry-After", String(ipResult.retryAfter));
      return next(new ApiError(429, "RATE-001", "Rate limited."));
    }
    const auth = req.header("authorization");
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const token = (m[1] ?? "").trim();
      if (isAdminToken(config, token)) {
        const adminResult = consume(`admin:${sha256Hex(token)}`, limits.admin);
        if (!adminResult.ok) {
          res.setHeader("Retry-After", String(adminResult.retryAfter));
          return next(new ApiError(429, "RATE-001", "Rate limited."));
        }
      } else {
        const devResult = consume(`dev:${sha256Hex(token)}`, limits.device);
        if (!devResult.ok) {
          res.setHeader("Retry-After", String(devResult.retryAfter));
          return next(new ApiError(429, "RATE-001", "Rate limited."));
        }
      }
    }
    next();
  }) as RateLimiter;

  middleware.bucketCount = () => buckets.size;
  return middleware;
}
import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimitMiddleware, type RateLimiter } from "../src/http/rate-limit";
import { makeConfig } from "./helpers";

afterEach(() => vi.useRealTimers());

function limiter(perMinute = 1000): RateLimiter {
  const config = makeConfig("");
  config.limits.ratePerMinutePerDevice = perMinute;
  config.limits.ratePerMinutePerIp = perMinute;
  return rateLimitMiddleware(config);
}

function call(rate: RateLimiter, ip: string) {
  const req = {
    header: () => undefined,
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
  const res = { setHeader: vi.fn() } as unknown as Response;
  const next = vi.fn() as NextFunction;
  rate(req, res, next);
  return next;
}

describe("rate limiter housekeeping (P3)", () => {
  it("evicts idle buckets after 10 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z"));
    const rate = limiter();
    call(rate, "10.0.0.1");
    expect(rate.bucketCount()).toBe(1);
    vi.advanceTimersByTime(11 * 60 * 1000);
    call(rate, "10.0.0.2");
    expect(rate.bucketCount()).toBe(1);
  });

  it("caps the bucket map at 10,000 entries", () => {
    const rate = limiter(100_000);
    for (let i = 0; i < 10_050; i++) {
      call(rate, `10.1.${Math.floor(i / 250)}.${i % 250}`);
    }
    expect(rate.bucketCount()).toBeLessThanOrEqual(10_000);
  });
});

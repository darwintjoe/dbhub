import { describe, expect, it } from "vitest";
import { z } from "zod";
import request from "supertest";
import pkg from "../package.json";
import { addDevice, makeApp, makeCtx } from "./helpers";
import { bundleSchema, validateBundleShape } from "../src/domain/validation";
import { configSchema } from "../src/config";
import type { BundleV1 } from "../src/domain/types";

function valid(): BundleV1 {
  return {
    bundleId: "bdl_1",
    companyId: "cmp_1",
    ledgerStreamId: "main",
    deviceId: "dev_1",
    userId: "u1",
    period: "2026-11",
    devicePrevHash: null,
    payloadHash: "a".repeat(64),
    bundleHash: "b".repeat(64),
    eventCount: 1,
    schemaVersion: 1,
    bundleFormatVersion: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    payload: [{ id: "evt_1", type: "journal.posted", schemaVersion: 1, data: {} }],
  };
}

describe("zod 4.6.7 migration", () => {
  it("pins the patched production dependency", () => {
    expect(pkg.dependencies.zod).toBe("^4.6.7");
    expect(pkg.devDependencies.vitest).toBeDefined();
  });

  it("keeps bundle validation semantics for malformed payloads", () => {
    const cases: Array<[string, BundleV1]> = [
      ["bad bundle id", { ...valid(), bundleId: "bdl" }],
      ["bad device id", { ...valid(), deviceId: "dev" }],
      ["bad period", { ...valid(), period: "2026/11" }],
      ["bad payload hash", { ...valid(), payloadHash: "xyz" }],
      ["bad bundle hash", { ...valid(), bundleHash: "xyz" }],
      ["event count mismatch", { ...valid(), eventCount: 2 }],
      ["unsupported schema", { ...valid(), schemaVersion: 2 }],
      ["unsupported bundle format", { ...valid(), bundleFormatVersion: 2 }],
      ["missing event id", { ...valid(), payload: [{ type: "journal.posted", schemaVersion: 1 }] }],
    ];
    for (const [label, input] of cases) {
      const result = validateBundleShape(input);
      expect(result.ok, label).toBe(false);
      const flatten = bundleSchema.safeParse(input);
      expect(flatten.success, label).toBe(false);
      if (!flatten.success) {
        expect(flatten.error.flatten(), label).toHaveProperty("fieldErrors");
      }
    }
    expect(validateBundleShape(valid()).ok).toBe(true);
  });

  it("keeps config parsing strict and ZodError formatting intact", () => {
    const base = {
      companyId: "cmp_1",
      replicaId: "hub_1",
      adminTokenHash: "a".repeat(64),
      dataDir: "/tmp/d",
      logDir: "/tmp/l",
    };
    expect(configSchema.safeParse(base).success).toBe(true);
    expect(configSchema.safeParse({ ...base, companyId: "" }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, adminTokenHash: "short" }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, port: 70000 }).success).toBe(false);
    const bad = configSchema.safeParse({ ...base, port: -1 });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.flatten().fieldErrors).toHaveProperty("port");
      expect(bad.error.flatten()).toEqual(z.flattenError(bad.error));
      expect(bad.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("does not accumulate unbounded issues for an oversized array (GHSA-mrhx-c7xc-m3w5)", () => {
    const oversized = Array.from({ length: 20_000 }, () => ({ id: 1 }));
    const started = Date.now();
    const result = validateBundleShape({ ...valid(), payload: oversized });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(15_000);
    // Growth must stay linear in input size, not unbounded/quadratic.
    const details = result.details as { fieldErrors?: Record<string, unknown[]> };
    const payloadIssues = details.fieldErrors?.payload;
    expect(Array.isArray(payloadIssues)).toBe(true);
    expect(payloadIssues!.length).toBeLessThanOrEqual(oversized.length * 10);
  });

  it("preserves exact API error codes for malformed requests", async () => {
    const ctx = makeCtx();
    try {
      const device = addDevice(ctx);
      const { app } = makeApp(ctx);

      const badPull = await request(app)
        .get("/api/v1/pull?since=-1")
        .set("Authorization", "Bearer dev-token");
      expect(badPull.status).toBe(400);
      expect(badPull.body.error.code).toBe("BUNDLE-001");

      const badDevice = await request(app)
        .post("/api/v1/admin/devices")
        .set("Authorization", "Bearer admin-token")
        .send({});
      expect(badDevice.status).toBe(400);
      expect(badDevice.body.error.code).toBe("BUNDLE-001");

      const badLabel = await request(app)
        .patch(`/api/v1/admin/devices/${device.id}`)
        .set("Authorization", "Bearer admin-token")
        .send({ label: "x".repeat(81) });
      expect(badLabel.status).toBe(400);
      expect(badLabel.body.error.code).toBe("CONFIG-001");

      const badConfig = await request(app)
        .put("/api/v1/admin/config")
        .set("Authorization", "Bearer admin-token")
        .send({ config: { companyId: "" }, force: false });
      expect(badConfig.status).toBe(400);
      expect(badConfig.body.error.code).toBe("CONFIG-001");
    } finally {
      ctx.cleanup();
    }
  });
});

import { describe, expect, it } from "vitest";
import { validateBundleShape, duplicateEventIdsInPayload } from "../src/domain/validation";
import { evaluateContinuity } from "../src/domain/chain";
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

describe("validation", () => {
  it("accepts a valid bundle", () => {
    expect(validateBundleShape(valid()).ok).toBe(true);
  });

  it("rejects bad shape", () => {
    expect(validateBundleShape({ ...valid(), bundleId: "bad" }).ok).toBe(false);
  });

  it("rejects eventCount mismatch", () => {
    expect(validateBundleShape({ ...valid(), eventCount: 2 }).ok).toBe(false);
  });

  it("rejects unsupported schema/bundle format", () => {
    expect(validateBundleShape({ ...valid(), schemaVersion: 2 }).ok).toBe(false);
    expect(validateBundleShape({ ...valid(), bundleFormatVersion: 2 }).ok).toBe(false);
  });

  it("finds duplicate event ids", () => {
    const p = [{ id: "evt_1" }, { id: "evt_1" }];
    expect(duplicateEventIdsInPayload(p)).toEqual(["evt_1"]);
  });

  it("continuity: null first, correct continuation, break, missing parent", () => {
    expect(evaluateContinuity(null, null, false)).toEqual({ kind: "accepted" });
    expect(evaluateContinuity("h1", "h1", true)).toEqual({ kind: "accepted" });
    expect(evaluateContinuity("h1", "h0", true)).toEqual({ kind: "quarantine", reason: "device_chain_break" });
    expect(evaluateContinuity("h1", "missing", false)).toEqual({ kind: "pending_parent" });
    expect(evaluateContinuity(null, "missing", false)).toEqual({ kind: "pending_parent" });
    expect(evaluateContinuity(null, "exists", true)).toEqual({ kind: "quarantine", reason: "device_chain_break" });
  });
});

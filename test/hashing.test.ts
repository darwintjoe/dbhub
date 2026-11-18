import { describe, expect, it } from "vitest";
import { bundleHashFromBundle, chainHash, payloadHash, sha256Hex, tokenHash } from "../src/domain/hashing";
import { canonicalJson } from "../src/domain/canonical";
import type { BundleV1 } from "../src/domain/types";

function sampleBundle(): BundleV1 {
  return {
    bundleId: "bdl_1",
    companyId: "cmp_1",
    ledgerStreamId: "main",
    deviceId: "dev_1",
    userId: "u1",
    period: "2026-11",
    devicePrevHash: null,
    payloadHash: "",
    bundleHash: "",
    eventCount: 1,
    schemaVersion: 1,
    bundleFormatVersion: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    payload: [{ id: "evt_1", type: "journal.posted", schemaVersion: 1, data: { amount: 100 } }],
  };
}

describe("hashing", () => {
  it("tokenHash stable", () => {
    expect(tokenHash("abc")).toBe(sha256Hex("abc"));
  });

  it("payloadHash uses canonical JSON", () => {
    const p = [{ b: 2, a: 1 }];
    expect(payloadHash(p)).toBe(sha256Hex(canonicalJson(p)));
    expect(payloadHash([{ a: 1, b: 2 }])).toBe(payloadHash(p));
  });

  it("bundleHash excludes bundleHash field and detects tampering", () => {
    const b = sampleBundle();
    const h = bundleHashFromBundle(b);
    expect(bundleHashFromBundle({ ...b, bundleHash: "different" })).toBe(h);
    b.payload[0].data = { amount: 101 };
    expect(bundleHashFromBundle(b)).not.toBe(h);
  });

  it("chainHash first and continuation", () => {
    const b1 = "a".repeat(64);
    const b2 = "b".repeat(64);
    const h1 = chainHash(null, b1);
    const h2 = chainHash(h1, b2);
    expect(h1).toBe(sha256Hex(b1));
    expect(h2).toBe(sha256Hex(`${h1}:${b2}`));
    expect(chainHash(h1, "c".repeat(64))).not.toBe(h2);
  });
});

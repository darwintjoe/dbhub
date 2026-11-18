import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical";
import type { BundleV1 } from "./types";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function tokenHash(token: string): string {
  return sha256Hex(token);
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

// Hash of the bundle object with its own `bundleHash` field removed.
export function bundleHashFromBundle(bundle: BundleV1 | Omit<BundleV1, "bundleHash">): string {
  const copy: Record<string, unknown> = { ...bundle };
  delete copy.bundleHash;
  return sha256Hex(canonicalJson(copy));
}

// Local hub chain: SHA-256 of the previous chain hash and this bundle hash.
// `||` here is concatenation, not logical OR: "<prev>:<bundleHash>".
// For the first bundle in the local chain there is no previous hash, so the
// input is just the bundle hash (no separator).
export function chainHash(prevChainHash: string | null, bundleHash: string): string {
  const input = prevChainHash === null ? bundleHash : `${prevChainHash}:${bundleHash}`;
  return sha256Hex(input);
}

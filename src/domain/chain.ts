// Per-device continuity is the only ordering guarantee in v0.
// The hub does NOT build a global linked list across devices; it orders
// bundles locally with hub_seq and links them into a local chain.

export type ContinuityDecision =
  | { kind: "accepted" }
  | { kind: "quarantine"; reason: "device_chain_break" }
  | { kind: "pending_parent" };

export function evaluateContinuity(
  lastAcceptedDeviceHash: string | null,
  devicePrevHash: string | null,
  devicePrevHashExistsInBundles: boolean,
): ContinuityDecision {
  if (lastAcceptedDeviceHash !== null) {
    if (lastAcceptedDeviceHash === devicePrevHash) return { kind: "accepted" };
  } else {
    if (devicePrevHash === null) return { kind: "accepted" };
  }
  // mismatch
  if (devicePrevHashExistsInBundles) {
    return { kind: "quarantine", reason: "device_chain_break" };
  }
  return { kind: "pending_parent" };
}

export function isPendingExpired(pendingSince: string, now: string, timeoutMs: number): boolean {
  return Date.parse(now) - Date.parse(pendingSince) >= timeoutMs;
}

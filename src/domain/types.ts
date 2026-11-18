export const VERSION = "0.2.0";
export const SUPPORTED_SCHEMA_VERSION = 1;
export const SUPPORTED_BUNDLE_FORMAT_VERSION = 1;

export interface LedgerEvent {
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt?: string;
  data: unknown;
}

export interface BundleV1 {
  bundleId: string;
  companyId: string;
  ledgerStreamId: string;
  deviceId: string;
  userId: string;
  period: string;
  devicePrevHash: string | null;
  payloadHash: string;
  bundleHash: string;
  eventCount: number;
  schemaVersion: number;
  bundleFormatVersion: number;
  createdAt: string;
  signature?: string;
  payload: LedgerEvent[];
}

export interface Manifest {
  manifestId: string;
  companyId: string;
  ledgerStreamId: string;
  replicaId: string;
  replicaType: "hub";
  latestBundleId: string | null;
  latestBundleHash: string | null;
  latestHubSeq: number;
  latestChainHash: string | null;
  latestAcceptedSeq: number;
  latestSnapshotId: string | null;
  latestClosedPeriod: string | null;
  schemaVersion: number;
  bundleFormatVersion: number;
  updatedAt: string;
}

export interface DeviceRow {
  id: string;
  companyId: string;
  prefix: string;
  label: string;
  tokenHash: string;
  status: "approved" | "revoked";
  createdAt: string;
  lastSeenAt: string | null;
}

export interface StoredBundle {
  hubSeq: number;
  acceptedSeq: number | null;
  bundleId: string;
  companyId: string;
  deviceId: string;
  userId: string | null;
  period: string | null;
  clientPrevHash: string | null;
  payloadHash: string;
  bundleHash: string;
  chainPrevHash: string | null;
  chainHash: string;
  eventCount: number;
  schemaVersion: number;
  bundleFormatVersion: number;
  createdAt: string;
  receivedAt: string;
  payloadJson: string;
  status: "accepted" | "pending_parent" | "quarantined";
  quarantineReason: string | null;
  pendingSince: string | null;
  globalBundleId: number | null;
  replicaTarget: string | null;
  replicaUri: string | null;
  payload: LedgerEvent[];
}

export type BundleStatus = StoredBundle["status"];

import type { Config } from "../../config";
import type { BundlesRepo } from "../../db/bundles.repo";
import type { ManifestsRepo } from "../../db/manifests.repo";
import type { ChainVerifyResult } from "../maintenance";
import type { PausableStorageAdapter, StorageAdapter } from "./storage-adapter";

export type ReplicaHealthLevel = "GOOD" | "WARNING" | "CRITICAL";

export interface ReplicaHealthReason {
  code: string;
  message: string;
}

export interface ReplicaHealth {
  level: ReplicaHealthLevel;
  score: number;
  label: string;
  message: string;
  action: string;
  reasons: ReplicaHealthReason[];
  checkedAt: string;
}

const COPY: Record<ReplicaHealthLevel, { score: number; label: string; message: string; action: string }> = {
  GOOD: {
    score: 100,
    label: "Well protected",
    message: "Your records are safely stored and up to date.",
    action: "Nothing needed right now",
  },
  WARNING: {
    score: 70,
    label: "Mostly protected",
    message: "Some copies of your records are behind. Normal work can continue.",
    action: "Check the connection",
  },
  CRITICAL: {
    score: 25,
    label: "Needs attention",
    message: "Your records need a safety check before new document numbers can be issued.",
    action: "Review data safety",
  },
};

export interface ReplicaHealthDeps {
  config: Config;
  bundles: BundlesRepo;
  manifests: ManifestsRepo;
  adapter: StorageAdapter | null;
  chainVerify: () => ChainVerifyResult | null;
}

/**
 * PRD §29 backup health, reduced to a plain-language Data Safety Score.
 * All user-visible strings avoid technical storage/integrity jargon (§23.2).
 */
export class ReplicaHealthService {
  private readonly deps: ReplicaHealthDeps;

  constructor(deps: ReplicaHealthDeps) {
    this.deps = deps;
  }

  async check(): Promise<ReplicaHealth> {
    const { config, bundles, manifests, adapter, chainVerify } = this.deps;
    const reasons: ReplicaHealthReason[] = [];
    let level: ReplicaHealthLevel = "GOOD";
    const raise = (next: ReplicaHealthLevel, code: string, message: string) => {
      if (next === "CRITICAL" || (next === "WARNING" && level === "GOOD")) level = next;
      reasons.push({ code, message });
    };

    const drive = (adapter as Partial<PausableStorageAdapter> | null)?.driveStatus?.();
    const verify = chainVerify();
    if (verify && !verify.ok) {
      raise("CRITICAL", "SAFETY-CHECK", "Some saved records do not match their safety checks.");
    }

    if (!adapter) {
      raise("WARNING", "SAFETY-COPY", "No off-device copy is configured yet.");
    } else {
      let healthy = false;
      try {
        healthy = await adapter.healthCheck();
      } catch {
        healthy = false;
      }
      if (!healthy) raise("CRITICAL", "SAFETY-COPY", "The off-device copy is not reachable.");
    }

    const manifest = manifests.get(config.replicaId);
    if (!manifest) {
      raise("WARNING", "SAFETY-SUMMARY", "The backup summary has not been created yet.");
    } else {
      const head = bundles.acceptedHead();
      if (manifest.latestChainHash !== (head?.chainHash ?? null)) {
        raise("WARNING", "SAFETY-SUMMARY", "The backup summary is behind the latest records.");
      }
      if (!manifest.latestSnapshotId) {
        raise("WARNING", "SAFETY-POINT", "No recovery point has been saved yet.");
      }
    }

    if (drive?.revoked) {
      raise("CRITICAL", "SAFETY-RECONNECT", drive.message);
    }

    if (bundles.countByStatus("quarantined") > 0) {
      raise("WARNING", "SAFETY-REVIEW", "A few records are waiting to be reviewed.");
    }

    const result: ReplicaHealth = { level, ...COPY[level], reasons, checkedAt: new Date().toISOString() };
    if (drive?.revoked) {
      result.message = drive.message;
      result.action = drive.action;
    }
    return result;
  }
}

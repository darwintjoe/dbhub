import type Database from "better-sqlite3";
import type { Config } from "../config";
import type { BundlesRepo } from "../db/bundles.repo";
import { isPendingExpired } from "../domain/chain";
import { chainHash } from "../domain/hashing";

export interface ChainVerifyResult {
  ok: boolean;
  checked: number;
  firstBadHubSeq?: number;
}

export class MaintenanceService {
  private readonly db: Database.Database;
  private readonly bundles: BundlesRepo;
  private readonly config: Config;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Database.Database, bundles: BundlesRepo, config: Config) {
    this.db = db;
    this.bundles = bundles;
    this.config = config;
  }

  sweepPendingParents(now = new Date().toISOString()): number {
    const timeout = this.config.quarantine.pendingParentTimeoutMs;
    const pending = this.db
      .prepare("SELECT hub_seq, pending_since FROM bundles WHERE status='pending_parent'")
      .all() as { hub_seq: number; pending_since: string | null }[];
    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of pending) {
        if (!row.pending_since) continue;
        if (!isPendingExpired(row.pending_since, now, timeout)) continue;
        this.bundles.markQuarantinedPendingTimeout(row.hub_seq, now);
        count++;
      }
    });
    tx();
    return count;
  }

  verifyChain(): ChainVerifyResult {
    const rows = this.db
      .prepare("SELECT hub_seq, bundle_hash, chain_prev_hash, chain_hash FROM bundles WHERE status='accepted' ORDER BY hub_seq ASC")
      .all() as { hub_seq: number; bundle_hash: string; chain_prev_hash: string | null; chain_hash: string }[];
    let prev: string | null = null;
    let checked = 0;
    for (const r of rows) {
      checked++;
      if (r.chain_prev_hash !== prev) {
        return { ok: false, checked, firstBadHubSeq: r.hub_seq };
      }
      const expected = chainHash(prev, r.bundle_hash);
      if (r.chain_hash !== expected) {
        return { ok: false, checked, firstBadHubSeq: r.hub_seq };
      }
      prev = r.chain_hash;
    }
    return { ok: true, checked };
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.sweepPendingParents();
      } catch {
        // logged by caller if needed
      }
    }, 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

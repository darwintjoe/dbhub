import type Database from "better-sqlite3";
import type { Manifest } from "../domain/types";

interface ManifestRow {
  replica_id: string;
  company_id: string;
  replica_type: string;
  latest_bundle_id: string | null;
  latest_bundle_hash: string | null;
  latest_hub_seq: number;
  latest_accepted_seq: number | null;
  latest_chain_hash: string | null;
  latest_snapshot_id: string | null;
  latest_closed_period: string | null;
  schema_version: number | null;
  bundle_format_version: number | null;
  updated_at: string;
}

export class ManifestsRepo {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.upsertStmt = db.prepare(`
      INSERT INTO manifests (
        replica_id, company_id, replica_type, latest_bundle_id, latest_bundle_hash,
        latest_hub_seq, latest_accepted_seq, latest_chain_hash, latest_snapshot_id,
        latest_closed_period, schema_version, bundle_format_version, updated_at
      ) VALUES (
        @replica_id, @company_id, @replica_type, @latest_bundle_id, @latest_bundle_hash,
        @latest_hub_seq, @latest_accepted_seq, @latest_chain_hash, @latest_snapshot_id,
        @latest_closed_period, @schema_version, @bundle_format_version, @updated_at
      )
      ON CONFLICT(replica_id) DO UPDATE SET
        company_id=excluded.company_id,
        replica_type=excluded.replica_type,
        latest_bundle_id=excluded.latest_bundle_id,
        latest_bundle_hash=excluded.latest_bundle_hash,
        latest_hub_seq=excluded.latest_hub_seq,
        latest_accepted_seq=excluded.latest_accepted_seq,
        latest_chain_hash=excluded.latest_chain_hash,
        latest_snapshot_id=excluded.latest_snapshot_id,
        latest_closed_period=excluded.latest_closed_period,
        schema_version=excluded.schema_version,
        bundle_format_version=excluded.bundle_format_version,
        updated_at=excluded.updated_at
    `);
    this.getStmt = db.prepare("SELECT * FROM manifests WHERE replica_id = ?");
  }

  upsert(m: Manifest): void {
    this.upsertStmt.run({
      replica_id: m.replicaId,
      company_id: m.companyId,
      replica_type: m.replicaType,
      latest_bundle_id: m.latestBundleId,
      latest_bundle_hash: m.latestBundleHash,
      latest_hub_seq: m.latestHubSeq,
      latest_accepted_seq: m.latestAcceptedSeq,
      latest_chain_hash: m.latestChainHash,
      latest_snapshot_id: m.latestSnapshotId,
      latest_closed_period: m.latestClosedPeriod,
      schema_version: m.schemaVersion,
      bundle_format_version: m.bundleFormatVersion,
      updated_at: m.updatedAt,
    });
  }

  get(replicaId: string): Manifest | null {
    const r = this.getStmt.get(replicaId) as ManifestRow | undefined;
    if (!r) return null;
    return {
      manifestId: r.replica_id,
      companyId: r.company_id,
      ledgerStreamId: "main",
      replicaId: r.replica_id,
      replicaType: "hub",
      latestBundleId: r.latest_bundle_id,
      latestBundleHash: r.latest_bundle_hash,
      latestHubSeq: r.latest_hub_seq,
      latestAcceptedSeq: r.latest_accepted_seq ?? 0,
      latestChainHash: r.latest_chain_hash,
      latestSnapshotId: r.latest_snapshot_id,
      latestClosedPeriod: r.latest_closed_period,
      schemaVersion: r.schema_version ?? 1,
      bundleFormatVersion: r.bundle_format_version ?? 1,
      updatedAt: r.updated_at,
    };
  }
}

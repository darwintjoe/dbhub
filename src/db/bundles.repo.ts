import type Database from "better-sqlite3";
import type { StoredBundle } from "../domain/types";

interface BundleRow {
  hub_seq: number;
  bundle_id: string;
  company_id: string;
  device_id: string;
  user_id: string | null;
  period: string | null;
  client_prev_hash: string | null;
  payload_hash: string;
  bundle_hash: string;
  chain_prev_hash: string | null;
  chain_hash: string;
  event_count: number;
  schema_version: number;
  bundle_format_version: number;
  created_at: string;
  received_at: string;
  payload_json: string;
  status: string;
  quarantine_reason: string | null;
  pending_since: string | null;
  global_bundle_id: number | null;
  replica_target: string | null;
  replica_uri: string | null;
}

function mapRow(r: BundleRow): StoredBundle {
  return {
    hubSeq: r.hub_seq,
    bundleId: r.bundle_id,
    companyId: r.company_id,
    deviceId: r.device_id,
    userId: r.user_id,
    period: r.period,
    clientPrevHash: r.client_prev_hash,
    payloadHash: r.payload_hash,
    bundleHash: r.bundle_hash,
    chainPrevHash: r.chain_prev_hash,
    chainHash: r.chain_hash,
    eventCount: r.event_count,
    schemaVersion: r.schema_version,
    bundleFormatVersion: r.bundle_format_version,
    createdAt: r.created_at,
    receivedAt: r.received_at,
    payloadJson: r.payload_json,
    status: r.status as StoredBundle["status"],
    quarantineReason: r.quarantine_reason,
    pendingSince: r.pending_since,
    globalBundleId: r.global_bundle_id,
    replicaTarget: r.replica_target,
    replicaUri: r.replica_uri,
    payload: JSON.parse(r.payload_json),
  };
}

export class BundlesRepo {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly byIdStmt: Database.Statement;
  private readonly byHashStmt: Database.Statement;
  private readonly existsHashStmt: Database.Statement;
  private readonly existsAcceptedHashStmt: Database.Statement;
  private readonly existsSettledHashStmt: Database.Statement;
  private readonly lastAcceptedDeviceStmt: Database.Statement;
  private readonly lastAcceptedHeadStmt: Database.Statement;
  private readonly lastAcceptedBeforeStmt: Database.Statement;
  private readonly pendingForDeviceStmt: Database.Statement;
  private readonly acceptedSinceStmt: Database.Statement;
  private readonly recentStmt: Database.Statement;
  private readonly quarantineListStmt: Database.Statement;
  private readonly quarantineDetailStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO bundles (
        bundle_id, company_id, device_id, user_id, period, client_prev_hash,
        payload_hash, bundle_hash, chain_prev_hash, chain_hash, event_count,
        schema_version, bundle_format_version, created_at, received_at,
        payload_json, status, quarantine_reason, pending_since, replica_target
      ) VALUES (
        @bundle_id, @company_id, @device_id, @user_id, @period, @client_prev_hash,
        @payload_hash, @bundle_hash, @chain_prev_hash, @chain_hash, @event_count,
        @schema_version, @bundle_format_version, @created_at, @received_at,
        @payload_json, @status, @quarantine_reason, @pending_since, @replica_target
      )
    `);
    this.byIdStmt = db.prepare("SELECT * FROM bundles WHERE bundle_id = ?");
    this.byHashStmt = db.prepare("SELECT * FROM bundles WHERE bundle_hash = ?");
    this.existsHashStmt = db.prepare("SELECT 1 FROM bundles WHERE bundle_hash = ? LIMIT 1");
    this.existsAcceptedHashStmt = db.prepare(
      "SELECT 1 FROM bundles WHERE bundle_hash = ? AND device_id = ? AND status = 'accepted' LIMIT 1",
    );
    this.existsSettledHashStmt = db.prepare(
      "SELECT 1 FROM bundles WHERE bundle_hash = ? AND status != 'pending_parent' LIMIT 1",
    );
    this.lastAcceptedDeviceStmt = db.prepare(
      "SELECT * FROM bundles WHERE device_id = ? AND status = 'accepted' ORDER BY hub_seq DESC LIMIT 1",
    );
    this.lastAcceptedHeadStmt = db.prepare(
      "SELECT * FROM bundles WHERE status = 'accepted' ORDER BY hub_seq DESC LIMIT 1",
    );
    this.lastAcceptedBeforeStmt = db.prepare(
      "SELECT * FROM bundles WHERE status = 'accepted' AND hub_seq < ? ORDER BY hub_seq DESC LIMIT 1",
    );
    this.pendingForDeviceStmt = db.prepare(
      "SELECT * FROM bundles WHERE device_id = ? AND status = 'pending_parent' ORDER BY hub_seq ASC",
    );
    this.acceptedSinceStmt = db.prepare(
      "SELECT * FROM bundles WHERE status = 'accepted' AND hub_seq > ? ORDER BY hub_seq ASC LIMIT ?",
    );
    this.recentStmt = db.prepare("SELECT * FROM bundles ORDER BY hub_seq DESC LIMIT ?");
    this.quarantineListStmt = db.prepare(
      "SELECT bundle_id, device_id, quarantine_reason, received_at, hub_seq, status FROM bundles WHERE status = ? ORDER BY hub_seq DESC LIMIT ?",
    );
    this.quarantineDetailStmt = db.prepare("SELECT * FROM bundles WHERE bundle_id = ?");
  }

  insert(input: Record<string, unknown>): number {
    const info = this.insertStmt.run(input);
    return Number(info.lastInsertRowid);
  }

  findByBundleId(bundleId: string): StoredBundle | null {
    const r = this.byIdStmt.get(bundleId) as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  findByBundleHash(hash: string): StoredBundle | null {
    const r = this.byHashStmt.get(hash) as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  existsBundleHash(hash: string): boolean {
    return Boolean(this.existsHashStmt.get(hash));
  }

  existsAcceptedBundleHash(hash: string, deviceId: string): boolean {
    return Boolean(this.existsAcceptedHashStmt.get(hash, deviceId));
  }

  existsSettledBundleHash(hash: string): boolean {
    return Boolean(this.existsSettledHashStmt.get(hash));
  }

  lastAcceptedForDevice(deviceId: string): StoredBundle | null {
    const r = this.lastAcceptedDeviceStmt.get(deviceId) as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  lastAcceptedHead(): StoredBundle | null {
    const r = this.lastAcceptedHeadStmt.get() as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  lastAcceptedBefore(hubSeq: number): StoredBundle | null {
    const r = this.lastAcceptedBeforeStmt.get(hubSeq) as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  pendingForDevice(deviceId: string): StoredBundle[] {
    return (this.pendingForDeviceStmt.all(deviceId) as BundleRow[]).map(mapRow);
  }

  acceptedSince(since: number, limit: number): StoredBundle[] {
    return (this.acceptedSinceStmt.all(since, limit) as BundleRow[]).map(mapRow);
  }

  recent(limit: number): StoredBundle[] {
    return (this.recentStmt.all(limit) as BundleRow[]).map(mapRow);
  }

  quarantineList(status: string, limit: number): { bundleId: string; deviceId: string; reason: string | null; receivedAt: string; hubSeq: number; status: string }[] {
    return (this.quarantineListStmt.all(status, limit) as {
      bundle_id: string;
      device_id: string;
      quarantine_reason: string | null;
      received_at: string;
      hub_seq: number;
      status: string;
    }[]).map((r) => ({
      bundleId: r.bundle_id,
      deviceId: r.device_id,
      reason: r.quarantine_reason,
      receivedAt: r.received_at,
      hubSeq: r.hub_seq,
      status: r.status,
    }));
  }

  quarantineDetail(bundleId: string): StoredBundle | null {
    const r = this.quarantineDetailStmt.get(bundleId) as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  markAccepted(hubSeq: number, chainPrevHash: string | null, chainHash: string, now: string): void {
    this.db
      .prepare(
        "UPDATE bundles SET status='accepted', chain_prev_hash=?, chain_hash=?, pending_since=NULL WHERE hub_seq=?",
      )
      .run(chainPrevHash, chainHash, hubSeq);
  }

  markQuarantinedPendingTimeout(hubSeq: number, now: string): void {
    this.db
      .prepare(
        "UPDATE bundles SET status='quarantined', quarantine_reason='missing_parent', pending_since=NULL WHERE hub_seq=?",
      )
      .run(hubSeq);
  }

  updateDeviceLastSeen(deviceId: string, now: string): void {
    this.db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(now, deviceId);
  }

  countByStatus(status: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM bundles WHERE status=?").get(status) as { c: number };
    return r.c;
  }

  countAll(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM bundles").get() as { c: number };
    return r.c;
  }

  countEvents(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return r.c;
  }

  countDevices(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM devices").get() as { c: number };
    return r.c;
  }

  lastReceivedAt(): string | null {
    const r = this.db.prepare("SELECT MAX(received_at) AS m FROM bundles WHERE status='accepted'").get() as { m: string | null };
    return r.m;
  }

  // Device chain head is tracked in meta, not by hub_seq: pending bundles can
  // be accepted later with a lower hub_seq than their parent.
  getDeviceHead(deviceId: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(`device_head:${deviceId}`) as
      | { value: string }
      | undefined;
    return r ? r.value : null;
  }

  setDeviceHead(deviceId: string, bundleHash: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`device_head:${deviceId}`, bundleHash);
  }
}

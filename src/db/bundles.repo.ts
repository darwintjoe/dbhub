import type Database from "better-sqlite3";
import type { StoredBundle } from "../domain/types";

interface BundleRow {
  hub_seq: number;
  accepted_seq: number | null;
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
    acceptedSeq: r.accepted_seq,
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
  private readonly existsSettledHashStmt: Database.Statement;
  private readonly acceptedHeadStmt: Database.Statement;
  private readonly pendingForDeviceStmt: Database.Statement;
  private readonly acceptedSinceStmt: Database.Statement;
  private readonly recentStmt: Database.Statement;
  private readonly quarantineListStmt: Database.Statement;
  private readonly quarantineDetailStmt: Database.Statement;
  private readonly nextAcceptedSeqStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO bundles (
        bundle_id, company_id, device_id, user_id, period, client_prev_hash,
        payload_hash, bundle_hash, chain_prev_hash, chain_hash, event_count,
        schema_version, bundle_format_version, created_at, received_at,
        payload_json, status, quarantine_reason, pending_since, replica_target, accepted_seq
      ) VALUES (
        @bundle_id, @company_id, @device_id, @user_id, @period, @client_prev_hash,
        @payload_hash, @bundle_hash, @chain_prev_hash, @chain_hash, @event_count,
        @schema_version, @bundle_format_version, @created_at, @received_at,
        @payload_json, @status, @quarantine_reason, @pending_since, @replica_target, @accepted_seq
      )
    `);
    this.byIdStmt = db.prepare("SELECT * FROM bundles WHERE bundle_id = ?");
    this.byHashStmt = db.prepare("SELECT * FROM bundles WHERE bundle_hash = ?");
    this.existsSettledHashStmt = db.prepare(
      "SELECT 1 FROM bundles WHERE bundle_hash = ? AND status != 'pending_parent' LIMIT 1",
    );
    this.acceptedHeadStmt = db.prepare(
      "SELECT * FROM bundles WHERE status='accepted' ORDER BY accepted_seq DESC LIMIT 1",
    );
    this.pendingForDeviceStmt = db.prepare(
      "SELECT * FROM bundles WHERE device_id = ? AND status = 'pending_parent' ORDER BY hub_seq ASC",
    );
    this.acceptedSinceStmt = db.prepare(
      "SELECT * FROM bundles WHERE status = 'accepted' AND accepted_seq > ? ORDER BY accepted_seq ASC LIMIT ?",
    );
    this.recentStmt = db.prepare("SELECT * FROM bundles ORDER BY hub_seq DESC LIMIT ?");
    this.quarantineListStmt = db.prepare(
      "SELECT bundle_id, device_id, quarantine_reason, received_at, hub_seq, status FROM bundles WHERE status = ? ORDER BY hub_seq DESC LIMIT ?",
    );
    this.quarantineDetailStmt = db.prepare("SELECT * FROM bundles WHERE bundle_id = ?");
    // Only accepted rows carry a non-null accepted_seq (partial unique index),
    // so MAX(accepted_seq) is an O(1) index lookup without a status filter.
    this.nextAcceptedSeqStmt = db.prepare(
      "SELECT COALESCE(MAX(accepted_seq),0)+1 AS next FROM bundles",
    );
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

  existsSettledBundleHash(hash: string): boolean {
    return Boolean(this.existsSettledHashStmt.get(hash));
  }

  acceptedHead(): StoredBundle | null {
    const r = this.acceptedHeadStmt.get() as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  // Insertion-order head (max hub_seq), distinct from the chain head.
  lastAcceptedHead(): StoredBundle | null {
    const r = this.db
      .prepare("SELECT * FROM bundles WHERE status='accepted' ORDER BY hub_seq DESC LIMIT 1")
      .get() as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  nextAcceptedSeq(): number {
    const r = this.nextAcceptedSeqStmt.get() as { next: number };
    return r.next;
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
    return this.quarantineListFiltered({ status, limit });
  }

  quarantineListFiltered(opts: {
    status?: string;
    reason?: string;
    deviceId?: string;
    limit?: number;
    offset?: number;
  }): { bundleId: string; deviceId: string; reason: string | null; receivedAt: string; hubSeq: number; status: string }[] {
    const status = opts.status ?? "quarantined";
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where: string[] = ["status = ?"];
    const params: unknown[] = [status];
    if (opts.reason) {
      where.push("quarantine_reason = ?");
      params.push(opts.reason);
    }
    if (opts.deviceId) {
      where.push("device_id = ?");
      params.push(opts.deviceId);
    }
    const sql = `SELECT bundle_id, device_id, quarantine_reason, received_at, hub_seq, status FROM bundles WHERE ${where.join(" AND ")} ORDER BY hub_seq DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as {
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

  countByDeviceAndStatus(deviceId: string, status: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM bundles WHERE device_id=? AND status=?").get(deviceId, status) as { c: number };
    return r.c;
  }

  quarantineDetail(bundleId: string): StoredBundle | null {
    const r = this.quarantineDetailStmt.get(bundleId) as BundleRow | undefined;
    return r ? mapRow(r) : null;
  }

  markAccepted(hubSeq: number, acceptedSeq: number, chainPrevHash: string | null, chainHash: string): void {
    this.db
      .prepare(
        "UPDATE bundles SET status='accepted', accepted_seq=?, chain_prev_hash=?, chain_hash=?, pending_since=NULL WHERE hub_seq=?",
      )
      .run(acceptedSeq, chainPrevHash, chainHash, hubSeq);
  }

  markQuarantinedPendingTimeout(hubSeq: number, _now: string): void {
    const row = this.db.prepare("SELECT bundle_id FROM bundles WHERE hub_seq=?").get(hubSeq) as
      | { bundle_id: string }
      | undefined;
    this.db
      .prepare(
        "UPDATE bundles SET status='quarantined', quarantine_reason='missing_parent', pending_since=NULL WHERE hub_seq=?",
      )
      .run(hubSeq);
    if (row) this.deleteEventReservations(row.bundle_id);
  }

  markQuarantinedPending(hubSeq: number, reason: string): void {
    const row = this.db.prepare("SELECT bundle_id FROM bundles WHERE hub_seq=?").get(hubSeq) as
      | { bundle_id: string }
      | undefined;
    this.db
      .prepare("UPDATE bundles SET status='quarantined', quarantine_reason=?, pending_since=NULL WHERE hub_seq=?")
      .run(reason, hubSeq);
    if (row) this.deleteEventReservations(row.bundle_id);
  }

  reserveEventIds(bundleId: string, deviceId: string, eventIds: string[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO pending_event_ids (event_id, bundle_id, device_id) VALUES (?,?,?)",
    );
    for (const id of eventIds) stmt.run(id, bundleId, deviceId);
  }

  deleteEventReservations(bundleId: string): void {
    this.db.prepare("DELETE FROM pending_event_ids WHERE bundle_id=?").run(bundleId);
  }

  eventExistsInEvents(eventId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE event_id=? LIMIT 1").get(eventId));
  }

  eventIdReserved(eventId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM pending_event_ids WHERE event_id=? LIMIT 1").get(eventId));
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

  /** Accepted bundles received since an ISO timestamp, grouped by device_id. */
  countRecentByDevice(sinceIso: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT device_id, COUNT(*) AS c FROM bundles WHERE status='accepted' AND received_at >= ? GROUP BY device_id")
      .all(sinceIso) as { device_id: string; c: number }[];
    const out: Record<string, number> = {};
    for (const r of rows ?? []) out[r.device_id] = Number(r.c);
    return out;
  }

  /** Events attached to accepted bundles received since an ISO timestamp, grouped by device_id. */
  countRecentEventsByDevice(sinceIso: string): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT e.device_id AS device_id, COUNT(*) AS c FROM events e JOIN bundles b ON b.bundle_id = e.bundle_id " +
        "WHERE b.status='accepted' AND b.received_at >= ? GROUP BY e.device_id",
      )
      .all(sinceIso) as { device_id: string; c: number }[];
    const out: Record<string, number> = {};
    for (const r of rows ?? []) out[r.device_id] = Number(r.c);
    return out;
  }

  lastReceivedAt(): string | null {
    const r = this.db.prepare("SELECT MAX(received_at) AS m FROM bundles WHERE status='accepted'").get() as { m: string | null };
    return r.m;
  }

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

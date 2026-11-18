import type Database from "better-sqlite3";
import type { Config } from "../config";
import type { BundlesRepo } from "../db/bundles.repo";
import type { DevicesRepo } from "../db/devices.repo";
import type { ManifestsRepo } from "../db/manifests.repo";
import type { OutboxRepo } from "../db/outbox.repo";
import type { AuditRepo } from "../db/audit.repo";
import { ApiError } from "../http/errors";
import { bundleSchema, duplicateEventIdsInPayload, validateBundleShape } from "../domain/validation";
import { payloadHash, bundleHashFromBundle, chainHash } from "../domain/hashing";
import { evaluateContinuity } from "../domain/chain";
import type { BundleV1, DeviceRow, Manifest, StoredBundle } from "../domain/types";

export type IngestResult =
  | { status: "accepted"; hubSeq: number; chainHash: string }
  | { status: "pending_parent" }
  | { status: "quarantined"; reason: string }
  | { status: "duplicate"; hubSeq: number };

export class IngestService {
  private readonly db: Database.Database;
  private readonly config: Config;
  private readonly bundles: BundlesRepo;
  private readonly devices: DevicesRepo;
  private readonly manifests: ManifestsRepo;
  private readonly outbox: OutboxRepo;
  private readonly audit: AuditRepo;

  constructor(
    db: Database.Database,
    config: Config,
    bundles: BundlesRepo,
    devices: DevicesRepo,
    manifests: ManifestsRepo,
    outbox: OutboxRepo,
    audit: AuditRepo,
  ) {
    this.db = db;
    this.config = config;
    this.bundles = bundles;
    this.devices = devices;
    this.manifests = manifests;
    this.outbox = outbox;
    this.audit = audit;
  }

  ingest(raw: unknown, device: DeviceRow): IngestResult {
    const shape = validateBundleShape(raw);
    if (!shape.ok) {
      throw new ApiError(400, "BUNDLE-001", "Malformed bundle body.", { details: shape.details });
    }
    const bundle = shape.data as BundleV1;

    if (bundle.companyId !== this.config.companyId) {
      throw new ApiError(409, "BUNDLE-002", "Company mismatch.");
    }

    const recomputedPayloadHash = payloadHash(bundle.payload);
    const recomputedBundleHash = bundleHashFromBundle(bundle);
    const hashMismatch = recomputedPayloadHash !== bundle.payloadHash || recomputedBundleHash !== bundle.bundleHash;

    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      // Hash mismatch -> quarantine
      if (hashMismatch) {
        const hubSeq = this.bundles.insert({
          bundle_id: bundle.bundleId,
          company_id: bundle.companyId,
          device_id: device.id,
          user_id: bundle.userId,
          period: bundle.period,
          client_prev_hash: bundle.devicePrevHash,
          payload_hash: bundle.payloadHash,
          bundle_hash: bundle.bundleHash,
          chain_prev_hash: null,
          chain_hash: bundle.bundleHash,
          event_count: bundle.eventCount,
          schema_version: bundle.schemaVersion,
          bundle_format_version: bundle.bundleFormatVersion,
          created_at: bundle.createdAt,
          received_at: now,
          payload_json: JSON.stringify(bundle.payload),
          status: "quarantined",
          quarantine_reason: "hash_mismatch",
          pending_since: null,
          replica_target: this.config.storage.target,
        });
        this.audit.log(now, device.id, "bundle.quarantined", { reason: "hash_mismatch", hubSeq });
        return { status: "quarantined" as const, reason: "hash_mismatch" };
      }

      // Idempotency
      const existing = this.bundles.findByBundleId(bundle.bundleId) ?? this.bundles.findByBundleHash(bundle.bundleHash);
      if (existing) {
        return { status: "duplicate" as const, hubSeq: existing.hubSeq };
      }

      // Duplicate events
      const dupWithin = duplicateEventIdsInPayload(bundle.payload);
      const dupExisting = bundle.payload.filter((e) => this.eventExists(e.id)).map((e) => e.id);
      if (dupWithin.length > 0 || dupExisting.length > 0) {
        const hubSeq = this.bundles.insert({
          bundle_id: bundle.bundleId,
          company_id: bundle.companyId,
          device_id: device.id,
          user_id: bundle.userId,
          period: bundle.period,
          client_prev_hash: bundle.devicePrevHash,
          payload_hash: bundle.payloadHash,
          bundle_hash: bundle.bundleHash,
          chain_prev_hash: null,
          chain_hash: bundle.bundleHash,
          event_count: bundle.eventCount,
          schema_version: bundle.schemaVersion,
          bundle_format_version: bundle.bundleFormatVersion,
          created_at: bundle.createdAt,
          received_at: now,
          payload_json: JSON.stringify(bundle.payload),
          status: "quarantined",
          quarantine_reason: "duplicate_event",
          pending_since: null,
          replica_target: this.config.storage.target,
        });
        this.audit.log(now, device.id, "bundle.quarantined", { reason: "duplicate_event", hubSeq });
        return { status: "quarantined" as const, reason: "duplicate_event" };
      }

      // Continuity
      const deviceHead = this.bundles.getDeviceHead(device.id);
      // A pending parent is not yet a settled bundle; otherwise a grandchild
      // posted out of order would be wrongfully quarantined as a chain break.
      const parentExists = bundle.devicePrevHash !== null && this.bundles.existsSettledBundleHash(bundle.devicePrevHash);
      const decision = evaluateContinuity(deviceHead, bundle.devicePrevHash, parentExists);

      if (decision.kind === "quarantine") {
        const hubSeq = this.bundles.insert({
          bundle_id: bundle.bundleId,
          company_id: bundle.companyId,
          device_id: device.id,
          user_id: bundle.userId,
          period: bundle.period,
          client_prev_hash: bundle.devicePrevHash,
          payload_hash: bundle.payloadHash,
          bundle_hash: bundle.bundleHash,
          chain_prev_hash: null,
          chain_hash: bundle.bundleHash,
          event_count: bundle.eventCount,
          schema_version: bundle.schemaVersion,
          bundle_format_version: bundle.bundleFormatVersion,
          created_at: bundle.createdAt,
          received_at: now,
          payload_json: JSON.stringify(bundle.payload),
          status: "quarantined",
          quarantine_reason: "device_chain_break",
          pending_since: null,
          replica_target: this.config.storage.target,
        });
        this.audit.log(now, device.id, "bundle.quarantined", { reason: "device_chain_break", hubSeq });
        return { status: "quarantined" as const, reason: "device_chain_break" };
      }

      if (decision.kind === "pending_parent") {
        const hubSeq = this.bundles.insert({
          bundle_id: bundle.bundleId,
          company_id: bundle.companyId,
          device_id: device.id,
          user_id: bundle.userId,
          period: bundle.period,
          client_prev_hash: bundle.devicePrevHash,
          payload_hash: bundle.payloadHash,
          bundle_hash: bundle.bundleHash,
          chain_prev_hash: null,
          chain_hash: bundle.bundleHash,
          event_count: bundle.eventCount,
          schema_version: bundle.schemaVersion,
          bundle_format_version: bundle.bundleFormatVersion,
          created_at: bundle.createdAt,
          received_at: now,
          payload_json: JSON.stringify(bundle.payload),
          status: "pending_parent",
          quarantine_reason: null,
          pending_since: now,
          replica_target: this.config.storage.target,
        });
        for (const e of bundle.payload) {
          this.db.prepare("INSERT INTO events (event_id, bundle_id, type, occurred_at, device_id) VALUES (?,?,?,?,?)").run(
            e.id,
            bundle.bundleId,
            e.type,
            e.occurredAt ?? null,
            device.id,
          );
        }
        this.bundles.updateDeviceLastSeen(device.id, now);
        this.audit.log(now, device.id, "bundle.pending_parent", { hubSeq });
        return { status: "pending_parent" as const };
      }

      // Accepted
      const head = this.bundles.lastAcceptedHead();
      const chainPrev = head ? head.chainHash : null;
      const chainH = chainHash(chainPrev, bundle.bundleHash);

      const hubSeq = this.bundles.insert({
        bundle_id: bundle.bundleId,
        company_id: bundle.companyId,
        device_id: device.id,
        user_id: bundle.userId,
        period: bundle.period,
        client_prev_hash: bundle.devicePrevHash,
        payload_hash: bundle.payloadHash,
        bundle_hash: bundle.bundleHash,
        chain_prev_hash: chainPrev,
        chain_hash: chainH,
        event_count: bundle.eventCount,
        schema_version: bundle.schemaVersion,
        bundle_format_version: bundle.bundleFormatVersion,
        created_at: bundle.createdAt,
        received_at: now,
        payload_json: JSON.stringify(bundle.payload),
        status: "accepted",
        quarantine_reason: null,
        pending_since: null,
        replica_target: this.config.storage.target,
      });

      for (const e of bundle.payload) {
        this.db.prepare("INSERT INTO events (event_id, bundle_id, type, occurred_at, device_id) VALUES (?,?,?,?,?)").run(
          e.id,
          bundle.bundleId,
          e.type,
          e.occurredAt ?? null,
          device.id,
        );
      }

      this.bundles.updateDeviceLastSeen(device.id, now);
      this.bundles.setDeviceHead(device.id, bundle.bundleHash);
      this.outbox.enqueue(bundle.bundleId, this.config.storage.target, now);

      // Update manifest
      const latest = this.bundles.lastAcceptedHead();
      if (latest) {
        const manifest: Manifest = {
          manifestId: this.config.replicaId,
          companyId: this.config.companyId,
          ledgerStreamId: "main",
          replicaId: this.config.replicaId,
          replicaType: "hub",
          latestBundleId: latest.bundleId,
          latestBundleHash: latest.bundleHash,
          latestHubSeq: latest.hubSeq,
          latestChainHash: latest.chainHash,
          latestSnapshotId: null,
          latestClosedPeriod: null,
          schemaVersion: bundle.schemaVersion,
          bundleFormatVersion: bundle.bundleFormatVersion,
          updatedAt: now,
        };
        this.manifests.upsert(manifest);
      }

      this.audit.log(now, device.id, "bundle.accepted", { hubSeq, chainHash: chainH });

      // Resolve pending children for this device.
      this.resolvePending(device.id, now);

      return { status: "accepted" as const, hubSeq, chainHash: chainH };
    });

    const result = tx() as IngestResult;

    // If accepted, result already includes. If quarantined/pending/duplicate okay.
    return result;
  }

  private eventExists(eventId: string): boolean {
    const r = this.db.prepare("SELECT 1 FROM events WHERE event_id = ? LIMIT 1").get(eventId);
    return Boolean(r);
  }

  private resolvePending(deviceId: string, now: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      const pending = this.bundles.pendingForDevice(deviceId);
      for (const p of pending) {
        const parentExists =
          p.clientPrevHash === null || this.bundles.existsAcceptedBundleHash(p.clientPrevHash, deviceId);
        if (!parentExists) continue;
        const prev = this.bundles.lastAcceptedBefore(p.hubSeq);
        const chainPrev = prev ? prev.chainHash : null;
        const chainH = chainHash(chainPrev, p.bundleHash);
        this.bundles.markAccepted(p.hubSeq, chainPrev, chainH, now);
        // Advance device head only when this bundle directly follows it.
        if (this.bundles.getDeviceHead(deviceId) === p.clientPrevHash) {
          this.bundles.setDeviceHead(deviceId, p.bundleHash);
        }
        this.outbox.enqueue(p.bundleId, this.config.storage.target, now);
        this.audit.log(now, deviceId, "bundle.resolved", { hubSeq: p.hubSeq });
        changed = true;
      }
    }
    // Resolving a pending bundle can insert an accepted bundle with a lower
    // hub_seq than already-accepted rows. Rebuild the whole local chain so
    // chain_prev_hash always matches the previous accepted row by hub_seq.
    this.rebuildHubChain();
    const latest = this.bundles.lastAcceptedHead();
    if (latest) {
      const manifest: Manifest = {
        manifestId: this.config.replicaId,
        companyId: this.config.companyId,
        ledgerStreamId: "main",
        replicaId: this.config.replicaId,
        replicaType: "hub",
        latestBundleId: latest.bundleId,
        latestBundleHash: latest.bundleHash,
        latestHubSeq: latest.hubSeq,
        latestChainHash: latest.chainHash,
        latestSnapshotId: null,
        latestClosedPeriod: null,
        schemaVersion: latest.schemaVersion,
        bundleFormatVersion: latest.bundleFormatVersion,
        updatedAt: now,
      };
      this.manifests.upsert(manifest);
    }
  }

  private rebuildHubChain(): void {
    const rows = this.db
      .prepare("SELECT hub_seq, bundle_hash FROM bundles WHERE status='accepted' ORDER BY hub_seq ASC")
      .all() as { hub_seq: number; bundle_hash: string }[];
    let prev: string | null = null;
    const update = this.db.prepare("UPDATE bundles SET chain_prev_hash=?, chain_hash=? WHERE hub_seq=?");
    for (const row of rows) {
      const h = chainHash(prev, row.bundle_hash);
      update.run(prev, h, row.hub_seq);
      prev = h;
    }
  }
}

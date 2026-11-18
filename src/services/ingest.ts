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
      // Idempotency/conflict BEFORE any insert. Retrying a tampered bundle
      // must never hit UNIQUE(bundle_id) / UNIQUE(bundle_hash) and 500.
      const byId = this.bundles.findByBundleId(bundle.bundleId);
      if (byId) {
        if (byId.bundleHash !== bundle.bundleHash) {
          throw new ApiError(409, "BUNDLE-006", "Bundle id already used with different content.");
        }
        if (byId.status === "quarantined") {
          return { status: "quarantined" as const, reason: byId.quarantineReason ?? "unknown" };
        }
        return { status: "duplicate" as const, hubSeq: byId.hubSeq };
      }
      const byHash = this.bundles.findByBundleHash(bundle.bundleHash);
      if (byHash) {
        if (byHash.status === "quarantined") {
          return { status: "quarantined" as const, reason: byHash.quarantineReason ?? "unknown" };
        }
        return { status: "duplicate" as const, hubSeq: byHash.hubSeq };
      }

      // Hash mismatch -> quarantine (only for genuinely new bundles).
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
          accepted_seq: null,
        });
        this.audit.log(now, device.id, "bundle.quarantined", { reason: "hash_mismatch", hubSeq });
        return { status: "quarantined" as const, reason: "hash_mismatch" };
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
          accepted_seq: null,
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
          accepted_seq: null,
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
          accepted_seq: null,
        });
        this.bundles.reserveEventIds(
          bundle.bundleId,
          device.id,
          bundle.payload.map((e) => e.id),
        );
        this.bundles.updateDeviceLastSeen(device.id, now);
        this.audit.log(now, device.id, "bundle.pending_parent", { hubSeq });
        return { status: "pending_parent" as const };
      }

      // Accepted: accepted_seq and chain values are assigned once, here.
      const chainPrev = this.bundles.acceptedHead()?.chainHash ?? null;
      const chainH = chainHash(chainPrev, bundle.bundleHash);
      const acceptedSeq = this.bundles.nextAcceptedSeq();

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
        accepted_seq: acceptedSeq,
      });

      this.insertEvents(bundle.bundleId, device.id, bundle.payload);

      this.bundles.updateDeviceLastSeen(device.id, now);
      this.bundles.setDeviceHead(device.id, bundle.bundleHash);
      this.outbox.enqueue(bundle.bundleId, this.config.storage.target, now);
      this.audit.log(now, device.id, "bundle.accepted", { hubSeq, acceptedSeq, chainHash: chainH });

      // Resolve pending children for this device.
      this.resolvePending(device.id, now);

      return { status: "accepted" as const, hubSeq, chainHash: chainH };
    });

    const result = tx() as IngestResult;

    // If accepted, result already includes. If quarantined/pending/duplicate okay.
    return result;
  }

  private eventExists(eventId: string): boolean {
    return this.bundles.eventExistsInEvents(eventId) || this.bundles.eventIdReserved(eventId);
  }

  private insertEvents(bundleId: string, deviceId: string, payload: { id: string; type: string; occurredAt?: string }[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO events (event_id, bundle_id, type, occurred_at, device_id) VALUES (?,?,?,?,?)",
    );
    for (const e of payload) {
      stmt.run(e.id, bundleId, e.type, e.occurredAt ?? null, deviceId);
    }
  }

  private resolvePending(deviceId: string, now: string): void {
    // Strict resolution: only the pending bundle directly following the
    // current device head may be accepted. A parent merely existing somewhere
    // is not enough; that would silently accept forks.
    for (;;) {
      const head = this.bundles.getDeviceHead(deviceId);
      const next = this.bundles.pendingForDevice(deviceId).find((p) => p.clientPrevHash === head);
      if (!next) break;

      // An event id may have been won by an accepted bundle while this one
      // waited. Quarantine instead of throwing a UNIQUE violation.
      const collision = next.payload.some((e) => this.bundles.eventExistsInEvents(e.id));
      if (collision) {
        this.bundles.markQuarantinedPending(next.hubSeq, "duplicate_event");
        this.audit.log(now, deviceId, "bundle.event_race_rejected", { hubSeq: next.hubSeq });
        continue;
      }

      const chainPrev = this.bundles.acceptedHead()?.chainHash ?? null;
      const chainH = chainHash(chainPrev, next.bundleHash);
      const acceptedSeq = this.bundles.nextAcceptedSeq();
      this.bundles.markAccepted(next.hubSeq, acceptedSeq, chainPrev, chainH);
      this.bundles.deleteEventReservations(next.bundleId);
      this.insertEvents(next.bundleId, deviceId, next.payload);
      this.bundles.setDeviceHead(deviceId, next.bundleHash);
      this.outbox.enqueue(next.bundleId, this.config.storage.target, now);
      this.audit.log(now, deviceId, "bundle.resolved", { hubSeq: next.hubSeq, acceptedSeq });
    }

    const head = this.bundles.getDeviceHead(deviceId);
    for (const p of this.bundles.pendingForDevice(deviceId)) {
      const isFork =
        (p.clientPrevHash === null && head !== null) ||
        (p.clientPrevHash !== null &&
          p.clientPrevHash !== head &&
          this.bundles.existsSettledBundleHash(p.clientPrevHash));
      if (!isFork) continue;
      this.bundles.markQuarantinedPending(p.hubSeq, "device_chain_break");
      this.audit.log(now, deviceId, "bundle.fork_rejected", { hubSeq: p.hubSeq });
    }

    const latest = this.bundles.acceptedHead();
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
        latestAcceptedSeq: latest.acceptedSeq ?? 0,
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
}

import type Database from "better-sqlite3";
import type { Config } from "../../config";
import type { BundlesRepo } from "../../db/bundles.repo";
import type { ManifestsRepo } from "../../db/manifests.repo";
import type { Manifest } from "../../domain/types";
import { SUPPORTED_BUNDLE_FORMAT_VERSION, SUPPORTED_SCHEMA_VERSION } from "../../domain/types";
import { payloadHash } from "../../domain/hashing";
import type { ChainVerifyResult } from "../maintenance";
import type { MaintenanceService } from "../maintenance";
import {
  StorageObjectNotFoundError,
  type StorageAdapter,
} from "./storage-adapter";

export interface SnapshotEventRef {
  eventId: string;
  bundleId: string;
  type: string;
  occurredAt: string | null;
  deviceId: string;
}

export interface Snapshot {
  formatVersion: number;
  snapshotId: string;
  companyId: string;
  replicaId: string;
  createdAt: string;
  chain: {
    latestAcceptedSeq: number;
    latestHubSeq: number;
    latestChainHash: string | null;
    latestBundleId: string | null;
    latestBundleHash: string | null;
  };
  events: SnapshotEventRef[];
  eventCount: number;
}

export interface ClosingPack {
  formatVersion: number;
  closedPeriodId: string;
  period: string;
  ledgerCheckpointBundleId: string | null;
  ledgerCheckpointHash: string | null;
  trialBalanceHash: string;
  inventorySummaryHash: string;
  arApSummaryHash: string;
  bundleRangeStart: number | null;
  bundleRangeEnd: number | null;
  schemaVersion: number;
  createdByDevice: string;
  createdAt: string;
}

export interface RebuildResult {
  ok: boolean;
  snapshotId: string;
  eventsRestored: number;
  bundlesReplayed: number;
  chain: ChainVerifyResult;
  manifestValid: boolean;
  closingPacksValid: boolean;
  checkedAt: string;
}

export class RecoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
  }
}

interface EventRow {
  event_id: string;
  bundle_id: string;
  type: string;
  occurred_at: string | null;
  device_id: string;
}

/** Snapshot + closing pack + rebuild via the B1 StorageAdapter (PRD §25/§26). */
export class RecoveryService {
  private readonly db: Database.Database;
  private readonly config: Config;
  private readonly bundles: BundlesRepo;
  private readonly manifests: ManifestsRepo;
  private readonly adapter: StorageAdapter;
  private readonly maintenance: MaintenanceService;

  constructor(
    db: Database.Database,
    config: Config,
    bundles: BundlesRepo,
    manifests: ManifestsRepo,
    adapter: StorageAdapter,
    maintenance: MaintenanceService,
  ) {
    this.db = db;
    this.config = config;
    this.bundles = bundles;
    this.manifests = manifests;
    this.adapter = adapter;
    this.maintenance = maintenance;
  }

  private buildManifest(): Manifest {
    const existing = this.manifests.get(this.config.replicaId);
    if (existing) return existing;
    const head = this.bundles.acceptedHead();
    const insertionHead = this.bundles.lastAcceptedHead();
    return {
      manifestId: this.config.replicaId,
      companyId: this.config.companyId,
      ledgerStreamId: "main",
      replicaId: this.config.replicaId,
      replicaType: "hub",
      latestBundleId: head?.bundleId ?? null,
      latestBundleHash: head?.bundleHash ?? null,
      latestHubSeq: insertionHead?.hubSeq ?? 0,
      latestAcceptedSeq: head?.acceptedSeq ?? 0,
      latestChainHash: head?.chainHash ?? null,
      latestSnapshotId: null,
      latestClosedPeriod: null,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      bundleFormatVersion: SUPPORTED_BUNDLE_FORMAT_VERSION,
      updatedAt: new Date().toISOString(),
    };
  }

  private async saveManifest(next: Manifest): Promise<void> {
    this.manifests.upsert(next);
    await this.adapter.uploadManifest(JSON.stringify(next, null, 2));
  }

  async writeSnapshot(): Promise<{ snapshotId: string; uri: string; eventCount: number }> {
    const head = this.bundles.acceptedHead();
    const insertionHead = this.bundles.lastAcceptedHead();
    const events = this.db
      .prepare("SELECT event_id, bundle_id, type, occurred_at, device_id FROM events ORDER BY event_id")
      .all() as EventRow[];
    const snapshotId = `${Date.now()}-${this.config.replicaId}`;
    const snapshot: Snapshot = {
      formatVersion: 1,
      snapshotId,
      companyId: this.config.companyId,
      replicaId: this.config.replicaId,
      createdAt: new Date().toISOString(),
      chain: {
        latestAcceptedSeq: head?.acceptedSeq ?? 0,
        latestHubSeq: insertionHead?.hubSeq ?? 0,
        latestChainHash: head?.chainHash ?? null,
        latestBundleId: head?.bundleId ?? null,
        latestBundleHash: head?.bundleHash ?? null,
      },
      events: events.map((e) => ({
        eventId: e.event_id,
        bundleId: e.bundle_id,
        type: e.type,
        occurredAt: e.occurred_at,
        deviceId: e.device_id,
      })),
      eventCount: events.length,
    };
    // Key naming per PRD §25: snap-<id>.json (adapter appends the extension).
    const res = await this.adapter.uploadSnapshot(`snap-${snapshotId}`, Buffer.from(JSON.stringify(snapshot, null, 2)));
    await this.saveManifest({
      ...this.buildManifest(),
      latestSnapshotId: snapshotId,
      updatedAt: new Date().toISOString(),
    });
    return { snapshotId, uri: res.uri, eventCount: snapshot.eventCount };
  }

  async readSnapshot(): Promise<Snapshot | null> {
    const id = this.buildManifest().latestSnapshotId;
    if (!id) return null;
    try {
      const bytes = await this.adapter.downloadSnapshot(`snap-${id}`);
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as Snapshot;
    } catch (e) {
      if (e instanceof StorageObjectNotFoundError) return null;
      throw e;
    }
  }

  async writeClosingPack(period: string): Promise<{ period: string; uri: string; hash: string }> {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new RecoveryError("RECOVER-001", "Invalid closing period.");
    const ranges = this.db
      .prepare(
        "SELECT MIN(hub_seq) AS lo, MAX(hub_seq) AS hi FROM bundles WHERE period=? AND status='accepted'",
      )
      .get(period) as { lo: number | null; hi: number | null };
    const head = this.bundles.acceptedHead();
    const periodEvents = this.db
      .prepare(
        `SELECT e.event_id, e.type, e.device_id, b.period
         FROM events e JOIN bundles b ON b.bundle_id=e.bundle_id
         WHERE b.period=? AND b.status='accepted' ORDER BY e.event_id`,
      )
      .all(period) as { event_id: string; type: string; device_id: string; period: string }[];
    const toRefs = (rows: typeof periodEvents) =>
      rows.map((e) => ({ eventId: e.event_id, type: e.type, deviceId: e.device_id }));
    const pack: ClosingPack = {
      formatVersion: 1,
      closedPeriodId: `close-${period}`,
      period,
      ledgerCheckpointBundleId: head?.bundleId ?? null,
      ledgerCheckpointHash: head?.chainHash ?? null,
      trialBalanceHash: payloadHash(toRefs(periodEvents.filter((e) => e.type === "journal.posted"))),
      inventorySummaryHash: payloadHash(toRefs(periodEvents.filter((e) => e.type === "inventory.movement"))),
      arApSummaryHash: payloadHash(toRefs(periodEvents.filter((e) => e.type.startsWith("contact.")))),
      bundleRangeStart: ranges.lo,
      bundleRangeEnd: ranges.hi,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      createdByDevice: this.config.replicaId,
      createdAt: new Date().toISOString(),
    };
    // Key naming per PRD §25: close-YYYY-MM.json.
    const res = await this.adapter.uploadClosingPack(
      `close-${period}`,
      Buffer.from(JSON.stringify(pack, null, 2)),
    );
    await this.saveManifest({
      ...this.buildManifest(),
      latestClosedPeriod: period,
      updatedAt: new Date().toISOString(),
    });
    return { period, uri: res.uri, hash: pack.trialBalanceHash };
  }

  async readClosingPack(period: string): Promise<ClosingPack | null> {
    try {
      const bytes = await this.adapter.downloadClosingPack(`close-${period}`);
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as ClosingPack;
    } catch (e) {
      if (e instanceof StorageObjectNotFoundError) return null;
      throw e;
    }
  }

  /**
   * Rebuild derived data from snapshot + bundles after the snapshot horizon +
   * closing packs + manifest, then verify chain and validate (PRD §26).
   */
  async rebuild(): Promise<RebuildResult> {
    const snapshot = await this.readSnapshot();
    if (!snapshot) throw new RecoveryError("RECOVER-002", "No recovery point is available.");

    const manifest = this.buildManifest();
    const period = manifest.latestClosedPeriod;
    const pack = period ? await this.readClosingPack(period) : null;

    this.db.transaction(() => {
      // Derived data only: bundles, manifests and number state are source data.
      this.db.prepare("DELETE FROM events").run();
      for (const e of snapshot.events) {
        this.db
          .prepare("INSERT INTO events (event_id, bundle_id, type, occurred_at, device_id) VALUES (?,?,?,?,?)")
          .run(e.eventId, e.bundleId, e.type, e.occurredAt, e.deviceId);
      }
    })();

    const after = this.db
      .prepare(
        "SELECT * FROM bundles WHERE status='accepted' AND accepted_seq>? ORDER BY accepted_seq ASC",
      )
      .all(snapshot.chain.latestAcceptedSeq) as {
      hub_seq: number;
      bundle_id: string;
      device_id: string;
      payload_json: string;
    }[];
    let bundlesReplayed = 0;
    this.db.transaction(() => {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO events (event_id, bundle_id, type, occurred_at, device_id) VALUES (?,?,?,?,?)",
      );
      for (const b of after) {
        const payload = JSON.parse(b.payload_json) as {
          id?: unknown;
          type?: unknown;
          occurredAt?: unknown;
        }[];
        for (const ev of payload) {
          if (typeof ev.id !== "string" || typeof ev.type !== "string") continue;
          insert.run(
            ev.id,
            b.bundle_id,
            ev.type,
            typeof ev.occurredAt === "string" ? ev.occurredAt : null,
            b.device_id,
          );
        }
        bundlesReplayed++;
      }
    })();

    const chain = this.maintenance.verifyChain();
    const head = this.bundles.acceptedHead();
    const manifestValid =
      (head?.chainHash ?? null) === (manifest.latestChainHash ?? null) &&
      (head?.acceptedSeq ?? 0) === (manifest.latestAcceptedSeq ?? 0);
    let closingPacksValid = true;
    if (pack) {
      const refs = this.db
        .prepare(
          `SELECT e.event_id, e.type, e.device_id FROM events e
           JOIN bundles b ON b.bundle_id=e.bundle_id
           WHERE b.period=? AND b.status='accepted' AND e.type='journal.posted' ORDER BY e.event_id`,
        )
        .all(pack.period) as { event_id: string; type: string; device_id: string }[];
      closingPacksValid =
        payloadHash(refs.map((e) => ({ eventId: e.event_id, type: e.type, deviceId: e.device_id }))) ===
        pack.trialBalanceHash;
    }

    const result: RebuildResult = {
      ok: chain.ok && manifestValid && closingPacksValid,
      snapshotId: snapshot.snapshotId,
      eventsRestored: this.bundles.countEvents(),
      bundlesReplayed,
      chain,
      manifestValid,
      closingPacksValid,
      checkedAt: new Date().toISOString(),
    };
    if (!result.ok) throw new RecoveryError("RECOVER-003", "Recovery check did not pass.", );
    return result;
  }
}

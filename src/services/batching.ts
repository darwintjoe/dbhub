import type Database from "better-sqlite3";
import type { Config } from "../config";
import type { BundlesRepo } from "../db/bundles.repo";
import type { ManifestsRepo } from "../db/manifests.repo";
import type { OutboxRepo } from "../db/outbox.repo";
import type { ReplicaTarget } from "./replica/target";

export class BatchingService {
  private readonly db: Database.Database;
  private readonly bundles: BundlesRepo;
  private readonly manifests: ManifestsRepo;
  private readonly outbox: OutboxRepo;
  private readonly target: ReplicaTarget;
  private readonly config: Config;
  private readonly leaseMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    db: Database.Database,
    bundles: BundlesRepo,
    manifests: ManifestsRepo,
    outbox: OutboxRepo,
    target: ReplicaTarget,
    config: Config,
    leaseMs = 300_000,
  ) {
    this.db = db;
    this.bundles = bundles;
    this.manifests = manifests;
    this.outbox = outbox;
    this.target = target;
    this.config = config;
    this.leaseMs = leaseMs;
  }

  /** Call once at startup before start(). */
  resetOnStartup(now = new Date().toISOString()): number {
    return this.outbox.resetAllUploading(now);
  }

  /** Exposed for operators/tests: same sweep performed at processOnce start. */
  reclaimExpiredLeases(now = new Date().toISOString()): number {
    return this.outbox.resetExpiredLeases(now);
  }

  async processOnce(now = new Date().toISOString()): Promise<void> {
    // No overlapping runs: return the in-flight promise instead of starting a
    // second uploader against the same rows.
    if (this.running) return this.running;
    const run = this.runOnce(now).finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async runOnce(now: string): Promise<void> {
    // Reclaim leases that expired because the previous process died mid-upload.
    this.outbox.resetExpiredLeases(now);
    const rows = this.outbox.duePending(now, 20);
    for (const row of rows) {
      const bundle = this.bundles.findByBundleId(row.bundleId);
      if (!bundle) {
        this.outbox.update(row.id, "failed", row.attempts + 1, "bundle not found", null, now);
        continue;
      }
      const attempts = row.attempts + 1;
      const leaseExpiresAt = new Date(Date.parse(now) + this.leaseMs).toISOString();
      // Claim synchronously before the first await.
      this.outbox.claim(row.id, attempts, leaseExpiresAt, now);
      try {
        const res = await this.target.uploadBundle(bundle);
        const manifest = this.manifests.get(this.config.replicaId);
        if (manifest) await this.target.uploadManifest(manifest);
        if (!this.outbox.claimIfStillLeased(row.id, leaseExpiresAt)) continue;
        const finishedAt = new Date().toISOString();
        this.outbox.update(row.id, "done", attempts, null, null, finishedAt);
        this.db.prepare("UPDATE bundles SET replica_target=?, replica_uri=? WHERE bundle_id=?").run(
          this.target.name,
          res.uri,
          bundle.bundleId,
        );
      } catch (e) {
        if (!this.outbox.claimIfStillLeased(row.id, leaseExpiresAt)) continue;
        const err = e instanceof Error ? e.message : String(e);
        const backoff = Math.min(60_000, 1000 * Math.pow(2, attempts - 1));
        const next = new Date(Date.now() + backoff).toISOString();
        const finishedAt = new Date().toISOString();
        if (attempts >= 10) {
          this.outbox.update(row.id, "failed", attempts, err, null, finishedAt);
        } else {
          this.outbox.update(row.id, "pending", attempts, err, next, finishedAt);
        }
      }
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.processOnce().catch(() => undefined);
    }, 2000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => undefined);
  }
}

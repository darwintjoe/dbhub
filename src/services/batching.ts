import type Database from "better-sqlite3";
import type { Config } from "../config";
import type { BundlesRepo } from "../db/bundles.repo";
import type { ManifestsRepo } from "../db/manifests.repo";
import type { OutboxRepo } from "../db/outbox.repo";
import type { ReplicaTarget } from "./replica/target";
import type { Manifest, StoredBundle } from "../domain/types";

export class BatchingService {
  private readonly db: Database.Database;
  private readonly bundles: BundlesRepo;
  private readonly manifests: ManifestsRepo;
  private readonly outbox: OutboxRepo;
  private readonly target: ReplicaTarget;
  private readonly config: Config;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    db: Database.Database,
    bundles: BundlesRepo,
    manifests: ManifestsRepo,
    outbox: OutboxRepo,
    target: ReplicaTarget,
    config: Config,
  ) {
    this.db = db;
    this.bundles = bundles;
    this.manifests = manifests;
    this.outbox = outbox;
    this.target = target;
    this.config = config;
  }

  async processOnce(now = new Date().toISOString()): Promise<void> {
    const rows = this.outbox.duePending(now, 20);
    for (const row of rows) {
      const bundle = this.bundles.findByBundleId(row.bundleId);
      if (!bundle) {
        this.outbox.update(row.id, "failed", row.attempts + 1, "bundle not found", null, now);
        continue;
      }
      const attempts = row.attempts + 1;
      this.outbox.update(row.id, "uploading", attempts, row.lastError, row.nextRetryAt, now);
      try {
        const res = await this.target.uploadBundle(bundle);
        const manifest = this.manifests.get(this.config.replicaId);
        if (manifest) await this.target.uploadManifest(manifest);
        this.outbox.update(row.id, "done", attempts, null, null, new Date().toISOString());
        this.db.prepare("UPDATE bundles SET replica_target=?, replica_uri=? WHERE bundle_id=?").run(
          this.target.name,
          res.uri,
          bundle.bundleId,
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        const backoff = Math.min(60_000, 1000 * Math.pow(2, attempts - 1));
        const next = new Date(Date.now() + backoff).toISOString();
        if (attempts >= 10) {
          this.outbox.update(row.id, "failed", attempts, err, null, new Date().toISOString());
        } else {
          this.outbox.update(row.id, "pending", attempts, err, next, new Date().toISOString());
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDevice, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { BatchingService } from "../src/services/batching";
import { FolderTarget } from "../src/services/replica/folder-target";
import type { ReplicaTarget } from "../src/services/replica/target";
import type { Manifest, StoredBundle } from "../src/domain/types";

class FlakyTarget implements ReplicaTarget {
  readonly name = "flaky";
  calls = 0;
  async uploadBundle(_bundle: StoredBundle): Promise<{ uri: string }> {
    this.calls++;
    if (this.calls <= 2) throw new Error("network down");
    return { uri: "flaky://ok" };
  }
  async uploadManifest(_m: Manifest): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe("outbox batching", () => {
  it("retries with backoff then marks done with uri", async () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const b = makeBundle(d.id, null);
      ingest.ingest(b, d);
      const target = new FlakyTarget();
      const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, target, ctx.config);

      await batching.processOnce();
      let row = ctx.outbox.duePending(new Date(Date.now() + 60_000).toISOString(), 10)[0];
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.lastError).toContain("network down");
      expect(row.nextRetryAt).not.toBeNull();

      ctx.db.prepare("UPDATE outbox SET next_retry_at=NULL WHERE id=?").run(row.id);
      await batching.processOnce();
      row = ctx.outbox.duePending(new Date(Date.now() + 60_000).toISOString(), 10)[0];
      expect(row.attempts).toBe(2);
      expect(row.nextRetryAt).not.toBeNull();

      ctx.db.prepare("UPDATE outbox SET next_retry_at=NULL WHERE id=?").run(row.id);
      await batching.processOnce();
      const final = ctx.db.prepare("SELECT status, attempts, last_error, next_retry_at FROM outbox WHERE id=?").get(row.id) as {
        status: string;
        attempts: number;
        last_error: string | null;
        next_retry_at: string | null;
      };
      expect(final.status).toBe("done");
      expect(final.attempts).toBe(3);
      expect(target.calls).toBe(3);
      const stored = ctx.bundles.findByBundleId(b.bundleId)!;
      expect(stored.replicaUri).toBe("flaky://ok");
      expect(stored.replicaTarget).toBe("flaky");
    } finally {
      ctx.cleanup();
    }
  });

  it("FolderTarget writes bundle and manifest files", async () => {
    const ctx = makeCtx();
    try {
      const folder = path.join(ctx.config.dataDir, "replica");
      const d = addDevice(ctx);
      const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
      const b = makeBundle(d.id, null);
      ingest.ingest(b, d);
      const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, new FolderTarget(folder), ctx.config);
      await batching.processOnce();
      expect(fs.existsSync(path.join(folder, "manifest.json"))).toBe(true);
      const files = fs.readdirSync(path.join(folder, "bundles"));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain(b.bundleId);
    } finally {
      ctx.cleanup();
    }
  });
});

import type { Manifest, StoredBundle } from "../../domain/types";
import type { ReplicaTarget } from "./target";
import type { StorageAdapter } from "./storage-adapter";

/**
 * Bridges the legacy ReplicaTarget (used by BatchingService) to a B1
 * StorageAdapter. Used only when a cloud adapter is explicitly configured;
 * null/folder targets keep their existing behavior.
 */
export class StorageAdapterTarget implements ReplicaTarget {
  readonly name: string;
  private readonly adapter: StorageAdapter;

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
    this.name = adapter.name;
  }

  /** Forward a paused/revoked adapter so BatchingService can stop uploads. */
  isPaused(): boolean {
    const pausable = this.adapter as { isPaused?: () => boolean };
    return pausable.isPaused?.() ?? false;
  }

  async uploadBundle(bundle: StoredBundle): Promise<{ uri: string }> {
    const key = `b-${bundle.hubSeq}-${bundle.bundleId}`;
    return this.adapter.uploadBundle(key, Buffer.from(JSON.stringify(bundle)));
  }

  async uploadManifest(manifest: Manifest): Promise<void> {
    await this.adapter.uploadManifest(JSON.stringify(manifest));
  }

  async healthCheck(): Promise<boolean> {
    return this.adapter.healthCheck();
  }
}

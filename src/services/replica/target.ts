import type { Manifest, StoredBundle } from "../../domain/types";

export interface ReplicaTarget {
  readonly name: string;
  uploadBundle(bundle: StoredBundle): Promise<{ uri: string }>;
  uploadManifest(manifest: Manifest): Promise<void>;
  healthCheck(): Promise<boolean>;
}

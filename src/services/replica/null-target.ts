import type { Manifest, StoredBundle } from "../../domain/types";
import type { ReplicaTarget } from "./target";

export class NullTarget implements ReplicaTarget {
  readonly name = "null";
  async uploadBundle(_bundle: StoredBundle): Promise<{ uri: string }> {
    return { uri: "null://" };
  }
  async uploadManifest(_manifest: Manifest): Promise<void> {
    return;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

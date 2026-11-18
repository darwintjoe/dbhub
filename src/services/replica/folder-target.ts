import fs from "node:fs/promises";
import path from "node:path";
import type { Manifest, StoredBundle } from "../../domain/types";
import type { ReplicaTarget } from "./target";

export class FolderTarget implements ReplicaTarget {
  readonly name = "folder";
  private readonly folderPath: string;

  constructor(folderPath: string) {
    if (!folderPath) throw new Error("FolderTarget requires folderPath");
    this.folderPath = folderPath;
  }

  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  async uploadBundle(bundle: StoredBundle): Promise<{ uri: string }> {
    const bundlesDir = path.join(this.folderPath, "bundles");
    await this.ensureDir(bundlesDir);
    const fileName = `${String(bundle.hubSeq).padStart(10, "0")}-${bundle.bundleId}.json`;
    const filePath = path.join(bundlesDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
    return { uri: `file://${filePath}` };
  }

  async uploadManifest(manifest: Manifest): Promise<void> {
    await this.ensureDir(this.folderPath);
    await fs.writeFile(path.join(this.folderPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureDir(this.folderPath);
      return true;
    } catch {
      return false;
    }
  }
}

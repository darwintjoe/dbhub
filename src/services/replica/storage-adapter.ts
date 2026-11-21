import fs from "node:fs/promises";
import path from "node:path";

/**
 * Storage Abstraction Layer (plan §4.4 / PRD §14.3).
 *
 * Datastore-agnostic contract for replica objects. Payload bytes are opaque to
 * the adapter; hashing, sequencing and chain verification stay in the domain
 * layer. This is an additive seam: the legacy ReplicaTarget path used by
 * BatchingService is untouched by B1.
 */
export interface StorageAdapter {
  readonly name: string;
  connect(auth: unknown): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;
  uploadBundle(key: string, bytes: Uint8Array): Promise<{ uri: string }>;
  downloadBundle(key: string): Promise<Uint8Array>;
  /** Lexicographic listing, exclusive of fromKey when supplied. */
  listBundles(fromKey?: string): Promise<StorageObjectRef[]>;
  deleteBundle(key: string): Promise<void>;
  uploadSnapshot(id: string, bytes: Uint8Array): Promise<{ uri: string }>;
  downloadSnapshot(id: string): Promise<Uint8Array>;
  uploadClosingPack(period: string, bytes: Uint8Array): Promise<{ uri: string }>;
  downloadClosingPack(period: string): Promise<Uint8Array>;
  uploadManifest(json: string): Promise<{ uri: string }>;
  getManifest(): Promise<string | null>;
}

export interface StorageObjectRef {
  key: string;
  uri: string;
}

/** Raised by every adapter when a requested object is absent. */
export class StorageObjectNotFoundError extends Error {
  readonly code = "STORAGE_OBJECT_NOT_FOUND";
  readonly objectType: string;
  readonly key: string;

  constructor(objectType: string, key: string) {
    super(`${objectType} not found: ${key}`);
    this.name = "StorageObjectNotFoundError";
    this.objectType = objectType;
    this.key = key;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT";
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/** In-process adapter for tests/CI. No persistence across instances. */
export class MemoryAdapter implements StorageAdapter {
  readonly name = "memory";
  private readonly bundles = new Map<string, Uint8Array>();
  private readonly snapshots = new Map<string, Uint8Array>();
  private readonly closingPacks = new Map<string, Uint8Array>();
  private manifest: string | null = null;
  private connected = false;

  async connect(_auth: unknown): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  async uploadBundle(key: string, bytes: Uint8Array): Promise<{ uri: string }> {
    this.bundles.set(key, copyBytes(bytes));
    return { uri: `memory://bundle/${encodeURIComponent(key)}` };
  }

  async downloadBundle(key: string): Promise<Uint8Array> {
    const bytes = this.bundles.get(key);
    if (bytes === undefined) throw new StorageObjectNotFoundError("bundle", key);
    return copyBytes(bytes);
  }

  async listBundles(fromKey?: string): Promise<StorageObjectRef[]> {
    return [...this.bundles.keys()]
      .filter((key) => fromKey === undefined || key > fromKey)
      .sort(compareStrings)
      .map((key) => ({ key, uri: `memory://bundle/${encodeURIComponent(key)}` }));
  }

  async deleteBundle(key: string): Promise<void> {
    this.bundles.delete(key);
  }

  async uploadSnapshot(id: string, bytes: Uint8Array): Promise<{ uri: string }> {
    this.snapshots.set(id, copyBytes(bytes));
    return { uri: `memory://snapshot/${encodeURIComponent(id)}` };
  }

  async downloadSnapshot(id: string): Promise<Uint8Array> {
    const bytes = this.snapshots.get(id);
    if (bytes === undefined) throw new StorageObjectNotFoundError("snapshot", id);
    return copyBytes(bytes);
  }

  async uploadClosingPack(period: string, bytes: Uint8Array): Promise<{ uri: string }> {
    this.closingPacks.set(period, copyBytes(bytes));
    return { uri: `memory://closing-pack/${encodeURIComponent(period)}` };
  }

  async downloadClosingPack(period: string): Promise<Uint8Array> {
    const bytes = this.closingPacks.get(period);
    if (bytes === undefined) throw new StorageObjectNotFoundError("closing-pack", period);
    return copyBytes(bytes);
  }

  async uploadManifest(json: string): Promise<{ uri: string }> {
    this.manifest = json;
    return { uri: "memory://manifest.json" };
  }

  async getManifest(): Promise<string | null> {
    return this.manifest;
  }
}

/**
 * Filesystem adapter for tests/CI and local replicas. Keys are
 * percent-encoded into flat filenames, so separators and traversal sequences
 * cannot escape the configured root. No OS-specific paths or commands.
 */
export class LocalFolderAdapter implements StorageAdapter {
  readonly name = "local-folder";
  readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("LocalFolderAdapter requires a root path");
    this.root = path.resolve(root);
  }

  private objectPath(kind: string, key: string): string {
    return path.join(this.root, kind, `${encodeURIComponent(key)}.json`);
  }

  private async write(filePath: string, bytes: Uint8Array): Promise<{ uri: string }> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(bytes));
    return { uri: `file://${filePath}` };
  }

  private async read(filePath: string, kind: string, key: string): Promise<Uint8Array> {
    try {
      const buf = await fs.readFile(filePath);
      return Uint8Array.from(buf);
    } catch (e) {
      if (isNotFound(e)) throw new StorageObjectNotFoundError(kind, key);
      throw e;
    }
  }

  async connect(_auth: unknown): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async disconnect(): Promise<void> {
    // Filesystem holds no persistent handle to release.
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async uploadBundle(key: string, bytes: Uint8Array): Promise<{ uri: string }> {
    return this.write(this.objectPath("bundles", key), bytes);
  }

  async downloadBundle(key: string): Promise<Uint8Array> {
    return this.read(this.objectPath("bundles", key), "bundle", key);
  }

  async listBundles(fromKey?: string): Promise<StorageObjectRef[]> {
    const dir = path.join(this.root, "bundles");
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const items: StorageObjectRef[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let key: string;
      try {
        key = decodeURIComponent(name.slice(0, -5));
      } catch {
        continue;
      }
      if (fromKey !== undefined && key <= fromKey) continue;
      items.push({ key, uri: `file://${path.join(dir, name)}` });
    }
    return items.sort((a, b) => compareStrings(a.key, b.key));
  }

  async deleteBundle(key: string): Promise<void> {
    try {
      await fs.unlink(this.objectPath("bundles", key));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async uploadSnapshot(id: string, bytes: Uint8Array): Promise<{ uri: string }> {
    return this.write(this.objectPath("snapshots", id), bytes);
  }

  async downloadSnapshot(id: string): Promise<Uint8Array> {
    return this.read(this.objectPath("snapshots", id), "snapshot", id);
  }

  async uploadClosingPack(period: string, bytes: Uint8Array): Promise<{ uri: string }> {
    return this.write(this.objectPath("closing-packs", period), bytes);
  }

  async downloadClosingPack(period: string): Promise<Uint8Array> {
    return this.read(this.objectPath("closing-packs", period), "closing-pack", period);
  }

  async uploadManifest(json: string): Promise<{ uri: string }> {
    const filePath = path.join(this.root, "manifest.json");
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(filePath, json, "utf8");
    return { uri: `file://${filePath}` };
  }

  async getManifest(): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.root, "manifest.json"), "utf8");
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
}

/** No-op adapter mirroring the legacy NullTarget. Default factory result. */
export class NullStorageAdapter implements StorageAdapter {
  readonly name = "null";
  async connect(_auth: unknown): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async uploadBundle(key: string, _bytes: Uint8Array): Promise<{ uri: string }> {
    return { uri: `null://bundle/${encodeURIComponent(key)}` };
  }
  async downloadBundle(key: string): Promise<Uint8Array> {
    throw new StorageObjectNotFoundError("bundle", key);
  }
  async listBundles(): Promise<StorageObjectRef[]> {
    return [];
  }
  async deleteBundle(_key: string): Promise<void> {}
  async uploadSnapshot(id: string, _bytes: Uint8Array): Promise<{ uri: string }> {
    return { uri: `null://snapshot/${encodeURIComponent(id)}` };
  }
  async downloadSnapshot(id: string): Promise<Uint8Array> {
    throw new StorageObjectNotFoundError("snapshot", id);
  }
  async uploadClosingPack(period: string, _bytes: Uint8Array): Promise<{ uri: string }> {
    return { uri: `null://closing-pack/${encodeURIComponent(period)}` };
  }
  async downloadClosingPack(period: string): Promise<Uint8Array> {
    throw new StorageObjectNotFoundError("closing-pack", period);
  }
  async uploadManifest(_json: string): Promise<{ uri: string }> {
    return { uri: "null://manifest.json" };
  }
  async getManifest(): Promise<string | null> {
    return null;
  }
}

export type StorageAdapterKind = "null" | "memory" | "local-folder";

export interface StorageAdapterSettings {
  adapter?: StorageAdapterKind;
  folderPath?: string;
}

/**
 * Selects the adapter from config. "null" (the default) keeps the existing
 * no-op replica behavior; no legacy ReplicaTarget wiring is changed here.
 */
export function createStorageAdapter(settings: StorageAdapterSettings): StorageAdapter {
  switch (settings.adapter ?? "null") {
    case "memory":
      return new MemoryAdapter();
    case "local-folder":
      return new LocalFolderAdapter(settings.folderPath ?? "");
    case "null":
      return new NullStorageAdapter();
    default:
      return new NullStorageAdapter();
  }
}

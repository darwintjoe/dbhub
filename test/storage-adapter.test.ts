import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalFolderAdapter,
  MemoryAdapter,
  NullStorageAdapter,
  StorageObjectNotFoundError,
  createStorageAdapter,
  type StorageAdapter,
} from "../src/services/replica/storage-adapter";

type Harness = { adapter: StorageAdapter; cleanup: () => Promise<void> };

function runContract(label: string, make: () => Promise<Harness>): void {
  describe(`${label} — StorageAdapter contract`, () => {
    let adapter: StorageAdapter;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const h = await make();
      adapter = h.adapter;
      cleanup = h.cleanup;
      await adapter.connect(null);
    });

    afterEach(async () => {
      await adapter.disconnect();
      await cleanup();
    });

    it("reports healthy after connect", async () => {
      expect(await adapter.healthCheck()).toBe(true);
    });

    it("round-trips bundles byte-for-byte", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 250, 0, 7]);
      const res = await adapter.uploadBundle("b-0000000001", bytes);
      expect(res.uri).toContain("b-0000000001");
      expect(Array.from(await adapter.downloadBundle("b-0000000001"))).toEqual(Array.from(bytes));
    });

    it("round-trips snapshots and closing packs", async () => {
      const snap = new TextEncoder().encode('{"snapshot":true}');
      const close = new TextEncoder().encode('{"period":"2026-11"}');
      await adapter.uploadSnapshot("snap-1", snap);
      await adapter.uploadClosingPack("2026-11", close);
      expect(Array.from(await adapter.downloadSnapshot("snap-1"))).toEqual(Array.from(snap));
      expect(Array.from(await adapter.downloadClosingPack("2026-11"))).toEqual(Array.from(close));
    });

    it("stores and retrieves the manifest, null before first write", async () => {
      expect(await adapter.getManifest()).toBeNull();
      const json = '{"replicaId":"hub_1","latestHubSeq":3}';
      const res = await adapter.uploadManifest(json);
      expect(res.uri).toBeTruthy();
      expect(await adapter.getManifest()).toBe(json);
    });

    it("lists bundles lexicographically with an exclusive cursor", async () => {
      expect(await adapter.listBundles()).toEqual([]);
      for (const key of ["b-0000000003", "b-0000000001", "b-0000000002"]) {
        await adapter.uploadBundle(key, new Uint8Array([1]));
      }
      expect((await adapter.listBundles()).map((r) => r.key)).toEqual([
        "b-0000000001",
        "b-0000000002",
        "b-0000000003",
      ]);
      expect((await adapter.listBundles("b-0000000001")).map((r) => r.key)).toEqual([
        "b-0000000002",
        "b-0000000003",
      ]);
      expect((await adapter.listBundles("b-0000000003")).map((r) => r.key)).toEqual([]);
      expect((await adapter.listBundles("a-cursor")).map((r) => r.key)).toEqual([
        "b-0000000001",
        "b-0000000002",
        "b-0000000003",
      ]);
    });

    it("deletes a bundle and removes it from listings", async () => {
      await adapter.uploadBundle("b-1", new Uint8Array([9]));
      await adapter.uploadBundle("b-2", new Uint8Array([8]));
      await adapter.deleteBundle("b-1");
      expect((await adapter.listBundles()).map((r) => r.key)).toEqual(["b-2"]);
      await expect(adapter.downloadBundle("b-1")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it("throws typed errors for missing objects", async () => {
      await expect(adapter.downloadBundle("missing")).rejects.toMatchObject({
        code: "STORAGE_OBJECT_NOT_FOUND",
        objectType: "bundle",
        key: "missing",
      });
      await expect(adapter.downloadSnapshot("missing")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
      await expect(adapter.downloadClosingPack("missing")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });
  });
}

runContract("MemoryAdapter", async () => ({
  adapter: new MemoryAdapter(),
  cleanup: async () => {},
}));

runContract("LocalFolderAdapter", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbhub-sa-"));
  return {
    adapter: new LocalFolderAdapter(dir),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
});

describe("StorageAdapter factory", () => {
  it("defaults to no-op null adapter", () => {
    const adapter = createStorageAdapter({});
    expect(adapter).toBeInstanceOf(NullStorageAdapter);
    expect(adapter.name).toBe("null");
  });

  it("selects memory adapter", () => {
    expect(createStorageAdapter({ adapter: "memory" })).toBeInstanceOf(MemoryAdapter);
  });

  it("selects local-folder adapter with configured path", () => {
    const adapter = createStorageAdapter({ adapter: "local-folder", folderPath: "/tmp/dbhub-factory-test" });
    expect(adapter).toBeInstanceOf(LocalFolderAdapter);
    expect((adapter as LocalFolderAdapter).root).toBe(path.resolve("/tmp/dbhub-factory-test"));
  });

  it("null adapter stays no-op", async () => {
    const adapter = createStorageAdapter({});
    await adapter.connect(null);
    expect(await adapter.healthCheck()).toBe(true);
    expect(await adapter.getManifest()).toBeNull();
    expect(await adapter.listBundles()).toEqual([]);
    expect((await adapter.uploadBundle("k", new Uint8Array([1]))).uri).toContain("null://");
    await expect(adapter.downloadBundle("k")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });
});

describe("LocalFolderAdapter path safety", () => {
  it("does not let object keys escape the configured root", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbhub-sa-safe-"));
    const parent = path.dirname(dir);
    try {
      const adapter = new LocalFolderAdapter(dir);
      await adapter.connect(null);
      await adapter.uploadBundle("../escape", new Uint8Array([1]));
      await expect(fs.stat(path.join(parent, "escape.json"))).rejects.toThrow();
      expect((await adapter.listBundles()).map((r) => r.key)).toEqual(["../escape"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

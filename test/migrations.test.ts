import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database";
import { makeConfig } from "./helpers";
import { latestMigrationVersion } from "../src/db/migrations";

describe("migrations", () => {
  it("migrates empty DB to latest and reopen is no-op", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbhub-mig-"));
    try {
      const config = makeConfig(dir);
      const db1 = openDatabase(config);
      expect(db1.pragma("user_version", { simple: true })).toBe(latestMigrationVersion());
      const tables = db1.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      for (const t of ["bundles", "devices", "events", "manifests", "outbox", "audit_log", "number_blocks"]) {
        expect(tables.map((x) => x.name)).toContain(t);
      }
      db1.close();

      const db2 = openDatabase(config);
      expect(db2.pragma("user_version", { simple: true })).toBe(latestMigrationVersion());
      db2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

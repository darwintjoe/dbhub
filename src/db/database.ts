import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config";
import { runMigrations } from "./migrations";

export function openDatabase(config: Config): Database.Database {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, "hub.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}

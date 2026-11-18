import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { makeConfig } from "../helpers";
import type { Config } from "../../src/config";

export interface V1Fixture {
  db: Database.Database;
  config: Config;
  dbPath: string;
  cleanup: () => void;
}

// Intentionally duplicated v1 DDL. Production migrations must not be
// refactored to satisfy a test fixture.
const V1_DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE(company_id, prefix)
);
CREATE TABLE bundles (
  hub_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  user_id TEXT,
  period TEXT,
  client_prev_hash TEXT,
  payload_hash TEXT NOT NULL,
  bundle_hash TEXT NOT NULL UNIQUE,
  chain_prev_hash TEXT,
  chain_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  bundle_format_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  quarantine_reason TEXT,
  pending_since TEXT,
  global_bundle_id INTEGER,
  replica_target TEXT,
  replica_uri TEXT
);
CREATE INDEX idx_bundles_status_seq ON bundles(status, hub_seq);
CREATE INDEX idx_bundles_device ON bundles(device_id, hub_seq);
CREATE INDEX idx_bundles_hash ON bundles(bundle_hash);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES bundles(bundle_id),
  type TEXT NOT NULL,
  occurred_at TEXT,
  device_id TEXT NOT NULL
);
CREATE TABLE manifests (
  replica_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  replica_type TEXT NOT NULL,
  latest_bundle_id TEXT,
  latest_bundle_hash TEXT,
  latest_hub_seq INTEGER NOT NULL DEFAULT 0,
  latest_chain_hash TEXT,
  latest_snapshot_id TEXT,
  latest_closed_period TEXT,
  schema_version INTEGER,
  bundle_format_version INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(bundle_id, target)
);
CREATE TABLE number_blocks (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  prefix TEXT NOT NULL,
  range_from INTEGER NOT NULL,
  range_to INTEGER NOT NULL,
  next_value INTEGER NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
`;

export function createV1Fixture(): V1Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fazai-v1-fixture-"));
  const config = makeConfig(dir);
  const dbPath = path.join(dir, "hub.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(V1_DDL);
  db.pragma("user_version = 1");
  return {
    db,
    config,
    dbPath,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // ignore
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function deviceRow(id: string, prefix: string, companyId: string, tokenHash: string, createdAt: string) {
  return { id, companyId, prefix, label: id, tokenHash, status: "approved" as const, createdAt, lastSeenAt: null };
}

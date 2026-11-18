import type Database from "better-sqlite3";
import { chainHash } from "../domain/hashing";

interface Migration {
  version: number;
  sql?: string;
  up?: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS devices (
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

CREATE TABLE IF NOT EXISTS bundles (
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
CREATE INDEX IF NOT EXISTS idx_bundles_status_seq ON bundles(status, hub_seq);
CREATE INDEX IF NOT EXISTS idx_bundles_device ON bundles(device_id, hub_seq);
CREATE INDEX IF NOT EXISTS idx_bundles_hash ON bundles(bundle_hash);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES bundles(bundle_id),
  type TEXT NOT NULL,
  occurred_at TEXT,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manifests (
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

CREATE TABLE IF NOT EXISTS outbox (
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

CREATE TABLE IF NOT EXISTS number_blocks (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  prefix TEXT NOT NULL,
  range_from INTEGER NOT NULL,
  range_to INTEGER NOT NULL,
  next_value INTEGER NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
`,
  },
  {
    version: 2,
    // Additive only. v1 rows are backfilled once; old chain values are
    // recomputed in accepted order so every later write is immutable.
    sql: `
ALTER TABLE bundles ADD COLUMN accepted_seq INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bundles_accepted_seq ON bundles(accepted_seq) WHERE accepted_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bundles_device_status ON bundles(device_id, status, hub_seq);
ALTER TABLE manifests ADD COLUMN latest_accepted_seq INTEGER;
ALTER TABLE outbox ADD COLUMN lease_expires_at TEXT;
CREATE TABLE IF NOT EXISTS pending_event_ids (
  event_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  device_id TEXT NOT NULL
);
`,
    up: (db) => {
      const rows = db
        .prepare("SELECT hub_seq, bundle_hash FROM bundles WHERE status='accepted' ORDER BY hub_seq ASC")
        .all() as { hub_seq: number; bundle_hash: string }[];
      const update = db.prepare(
        "UPDATE bundles SET accepted_seq=?, chain_prev_hash=?, chain_hash=? WHERE hub_seq=?",
      );
      let prev: string | null = null;
      let seq = 0;
      for (const row of rows) {
        seq++;
        const h = chainHash(prev, row.bundle_hash);
        update.run(seq, prev, h, row.hub_seq);
        prev = h;
      }
      db.prepare("UPDATE manifests SET latest_accepted_seq=?").run(seq);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  const current = (db.pragma("user_version", { simple: true }) as number) || 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      if (m.up) m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
}

export function latestMigrationVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}

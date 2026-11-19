import type Database from "better-sqlite3";
import type { DeviceRow } from "../domain/types";

interface DeviceDbRow {
  id: string;
  company_id: string;
  prefix: string;
  label: string;
  token_hash: string;
  status: string;
  created_at: string;
  last_seen_at: string | null;
  scopes_json: string | null;
  platform: string | null;
  app_version: string | null;
  paired_at: string | null;
  token_expires_at: string | null;
  public_key: string | null;
}

function parseScopes(v: string | null): string[] {
  if (!v) return ["relay:write", "pull:read", "manifest:read"];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mapRow(r: DeviceDbRow): DeviceRow {
  return {
    id: r.id,
    companyId: r.company_id,
    prefix: r.prefix,
    label: r.label,
    tokenHash: r.token_hash,
    status: r.status as DeviceRow["status"],
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    scopes: parseScopes(r.scopes_json),
    platform: r.platform,
    appVersion: r.app_version,
    pairedAt: r.paired_at,
    tokenExpiresAt: r.token_expires_at,
    publicKey: r.public_key,
  };
}

export class DevicesRepo {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly byIdStmt: Database.Statement;
  private readonly byTokenHashStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly revokeStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      "INSERT INTO devices (id, company_id, prefix, label, token_hash, status, created_at, scopes_json, platform, app_version, paired_at, token_expires_at, public_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.byIdStmt = db.prepare("SELECT * FROM devices WHERE id = ?");
    this.byTokenHashStmt = db.prepare("SELECT * FROM devices WHERE token_hash = ?");
    this.listStmt = db.prepare("SELECT * FROM devices WHERE company_id = ? ORDER BY created_at ASC");
    this.revokeStmt = db.prepare("UPDATE devices SET status='revoked' WHERE id = ?");
  }

  create(d: DeviceRow): void {
    this.insertStmt.run(
      d.id,
      d.companyId,
      d.prefix,
      d.label,
      d.tokenHash,
      d.status,
      d.createdAt,
      JSON.stringify(d.scopes ?? ["relay:write", "pull:read", "manifest:read"]),
      d.platform ?? null,
      d.appVersion ?? null,
      d.pairedAt ?? null,
      d.tokenExpiresAt ?? null,
      d.publicKey ?? null,
    );
  }

  findById(id: string): DeviceRow | null {
    const r = this.byIdStmt.get(id) as DeviceDbRow | undefined;
    return r ? mapRow(r) : null;
  }

  findByTokenHash(hash: string): DeviceRow | null {
    const r = this.byTokenHashStmt.get(hash) as DeviceDbRow | undefined;
    return r ? mapRow(r) : null;
  }

  list(companyId: string): DeviceRow[] {
    return (this.listStmt.all(companyId) as DeviceDbRow[]).map(mapRow);
  }

  count(companyId?: string): number {
    if (companyId) return (this.db.prepare("SELECT COUNT(*) AS c FROM devices WHERE company_id=?").get(companyId) as { c: number }).c;
    return (this.db.prepare("SELECT COUNT(*) AS c FROM devices").get() as { c: number }).c;
  }

  revoke(id: string): void {
    this.revokeStmt.run(id);
  }

  updateLabel(id: string, label: string): void {
    this.db.prepare("UPDATE devices SET label=? WHERE id=?").run(label, id);
  }

  updateTokenHash(id: string, tokenHash: string, tokenExpiresAt: string | null = null): void {
    this.db.prepare("UPDATE devices SET token_hash=?, token_expires_at=? WHERE id=?").run(tokenHash, tokenExpiresAt, id);
  }

  updateScopes(id: string, scopes: string[]): void {
    this.db.prepare("UPDATE devices SET scopes_json=? WHERE id=?").run(JSON.stringify(scopes), id);
  }

  updateLastSeen(id: string, at: string): void {
    this.db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(at, id);
  }

  prefixExists(companyId: string, prefix: string): boolean {
    const r = this.db
      .prepare("SELECT 1 FROM devices WHERE company_id=? AND prefix=? LIMIT 1")
      .get(companyId, prefix);
    return Boolean(r);
  }

  /** One transaction; on a prefix race, retry once with the next suggestion. */
  createWithRetry(device: DeviceRow, explicit: boolean): { ok: true; prefix: string } | { ok: false } {
    return this.db.transaction(() => {
      if (explicit && this.prefixExists(device.companyId, device.prefix)) return { ok: false as const };
      if (!this.prefixExists(device.companyId, device.prefix)) {
        this.create(device);
        return { ok: true as const, prefix: device.prefix };
      }
      const retryPrefix = this.suggestPrefix(device.companyId);
      if (this.prefixExists(device.companyId, retryPrefix)) return { ok: false as const };
      this.create({ ...device, prefix: retryPrefix });
      return { ok: true as const, prefix: retryPrefix };
    })();
  }

  suggestPrefix(companyId: string): string {
    const used = new Set(this.list(companyId).map((d) => d.prefix));
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(65 + i);
      if (!used.has(c)) return c;
    }
    let n = 1;
    while (used.has(`DEV${n}`)) n++;
    return `DEV${n}`;
  }
}
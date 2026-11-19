import type Database from "better-sqlite3";

export class AuditRepo {
  private readonly db: Database.Database;
  private readonly stmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.stmt = db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)");
    this.listStmt = db.prepare("SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?");
    this.countStmt = db.prepare("SELECT COUNT(*) AS c FROM audit_log");
  }

  log(at: string, actor: string, action: string, detail?: unknown): void {
    this.stmt.run(at, actor, action, detail === undefined ? null : JSON.stringify(detail));
  }

  list(limit = 50, offset = 0): { id: number; at: string; actor: string; action: string; detail: unknown }[] {
    const rows = this.listStmt.all(limit, offset) as { id: number; at: string; actor: string; action: string; detail: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      detail: r.detail ? safeJson(r.detail) : null,
    }));
  }

  count(): number {
    const r = this.countStmt.get() as { c: number };
    return r.c;
  }
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

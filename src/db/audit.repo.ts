import type Database from "better-sqlite3";

export class AuditRepo {
  private readonly db: Database.Database;
  private readonly stmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.stmt = db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)");
  }

  log(at: string, actor: string, action: string, detail?: unknown): void {
    this.stmt.run(at, actor, action, detail === undefined ? null : JSON.stringify(detail));
  }
}

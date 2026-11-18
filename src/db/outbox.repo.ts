import type Database from "better-sqlite3";

export interface OutboxRow {
  id: number;
  bundleId: string;
  target: string;
  status: "pending" | "uploading" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DbRow {
  id: number;
  bundle_id: string;
  target: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function map(r: DbRow): OutboxRow {
  return {
    id: r.id,
    bundleId: r.bundle_id,
    target: r.target,
    status: r.status as OutboxRow["status"],
    attempts: r.attempts,
    lastError: r.last_error,
    nextRetryAt: r.next_retry_at,
    leaseExpiresAt: r.lease_expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class OutboxRepo {
  private readonly db: Database.Database;
  private readonly enqueueStmt: Database.Statement;
  private readonly dueStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly updateWithLeaseStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.enqueueStmt = db.prepare(`
      INSERT INTO outbox (bundle_id, target, status, attempts, created_at, updated_at)
      VALUES (?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(bundle_id, target) DO NOTHING
    `);
    this.dueStmt = db.prepare(`
      SELECT * FROM outbox
      WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY id ASC LIMIT ?
    `);
    this.updateStmt = db.prepare(`
      UPDATE outbox SET status=?, attempts=?, last_error=?, next_retry_at=?, updated_at=? WHERE id=?
    `);
    this.updateWithLeaseStmt = db.prepare(`
      UPDATE outbox SET status=?, attempts=?, last_error=?, next_retry_at=?, lease_expires_at=?, updated_at=? WHERE id=?
    `);
  }

  enqueue(bundleId: string, target: string, now: string): void {
    this.enqueueStmt.run(bundleId, target, now, now);
  }

  duePending(now: string, limit: number): OutboxRow[] {
    return (this.dueStmt.all(now, limit) as DbRow[]).map(map);
  }

  claim(id: number, attempts: number, leaseExpiresAt: string, now: string): void {
    // Synchronous, before any await.
    this.updateWithLeaseStmt.run("uploading", attempts, null, null, leaseExpiresAt, now, id);
  }

  claimIfStillLeased(id: number, leaseExpiresAt: string): boolean {
    const info = this.db
      .prepare("UPDATE outbox SET status='uploading' WHERE id=? AND status='uploading' AND lease_expires_at=?")
      .run(id, leaseExpiresAt);
    return info.changes > 0;
  }

  resetExpiredLeases(now: string): number {
    const info = this.db
      .prepare("UPDATE outbox SET status='pending', lease_expires_at=NULL, updated_at=? WHERE status='uploading' AND lease_expires_at < ?")
      .run(now, now);
    return info.changes;
  }

  resetAllUploading(now: string): number {
    const info = this.db
      .prepare("UPDATE outbox SET status='pending', lease_expires_at=NULL, updated_at=? WHERE status='uploading'")
      .run(now);
    return info.changes;
  }

  update(
    id: number,
    status: OutboxRow["status"],
    attempts: number,
    lastError: string | null,
    nextRetryAt: string | null,
    now: string,
  ): void {
    // Clear the lease on every terminal/retry transition.
    this.updateWithLeaseStmt.run(status, attempts, lastError, nextRetryAt, null, now, id);
  }

  counts(): { pending: number; failed: number; done: number; uploading: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS c FROM outbox GROUP BY status").all() as {
      status: string;
      c: number;
    }[];
    const out = { pending: 0, failed: 0, done: 0, uploading: 0 };
    for (const r of rows) {
      if (r.status in out) (out as Record<string, number>)[r.status] = r.c;
    }
    return out;
  }

  lastErrors(limit = 10): { bundleId: string; target: string; lastError: string | null }[] {
    const rows = this.db
      .prepare("SELECT bundle_id, target, last_error FROM outbox WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT ?")
      .all(limit) as { bundle_id: string; target: string; last_error: string | null }[];
    return rows.map((r) => ({ bundleId: r.bundle_id, target: r.target, lastError: r.last_error }));
  }
}

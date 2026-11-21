import type Database from "better-sqlite3";
import type { ReplicaHealth } from "../replica/replica-health";
import { NumberRelayError } from "./errors";
import type { DelegatedBlock, NumberDelegationClient, ReconcileRequest } from "./number-block-client";

interface BlockRow {
  id: string;
  doc_type: string;
  prefix: string;
  range_from: number;
  range_to: number;
  next_value: number;
  expires_at: string | null;
  status: string;
  quota_limit: number;
  quota_used: number;
}

interface IssuedRow {
  id: number;
  doc_type: string;
  prefix: string;
  number: number;
  idempotency_key: string;
  block_id: string;
  device_id: string;
  status: string;
  issued_at: string;
  reconciled_at: string | null;
}

export interface NextNumberRequest {
  docType: string;
  prefix: string;
  idempotencyKey: string;
  deviceId: string;
}

export interface NumberIssueResult {
  number: number;
  docType: string;
  prefix: string;
  blockId: string;
  idempotencyKey: string;
  issuedAt: string;
  warning?: string | undefined;
}

export type ReplicaHealthProvider = () => ReplicaHealth | Promise<ReplicaHealth>;

export interface BlockStatusView {
  blockId: string;
  docType: string;
  prefix: string;
  rangeFrom: number;
  rangeTo: number;
  nextValue: number;
  expiresAt: string | null;
  status: string;
  quotaLimit: number;
  quotaUsed: number;
  issued: number;
  voided: number;
  abandoned: number;
  consumed: number;
}

const DOC_TYPE_RE = /^[a-z0-9_-]{1,40}$/i;
const PREFIX_RE = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * Hub-side number relay. Consumes SaaS-delegated blocks, allocates numbers
 * gaplessly within a prefix, never reuses a number, and records voided and
 * abandoned numbers locally before reporting reconciliation upstream.
 */
export class NumberRelayService {
  private readonly db: Database.Database;
  private readonly delegation: NumberDelegationClient;
  private readonly defaultBlockSize: number;
  private readonly healthProvider?: ReplicaHealthProvider | undefined;

  constructor(
    db: Database.Database,
    delegation: NumberDelegationClient,
    defaultBlockSize = 20,
    healthProvider?: ReplicaHealthProvider,
  ) {
    this.db = db;
    this.delegation = delegation;
    this.defaultBlockSize = defaultBlockSize;
    this.healthProvider = healthProvider;
  }

  private validate(docType: string, prefix: string): void {
    if (!DOC_TYPE_RE.test(docType) || !PREFIX_RE.test(prefix)) {
      throw new NumberRelayError("NUM-001", "Invalid doc_type or prefix.");
    }
  }

  private blockById(id: string): BlockRow | undefined {
    return this.db.prepare("SELECT * FROM number_blocks WHERE id=?").get(id) as BlockRow | undefined;
  }

  private activeBlock(docType: string, prefix: string): BlockRow | undefined {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM number_blocks
         WHERE doc_type=? AND prefix=? AND status='active' AND next_value<=range_to
           AND (expires_at IS NULL OR expires_at>?)
         ORDER BY range_from ASC LIMIT 1`,
      )
      .get(docType, prefix, now) as BlockRow | undefined;
  }

  async issueBlock(req: {
    docType: string;
    prefix: string;
    size?: number | undefined;
    deviceId: string;
  }): Promise<DelegatedBlock> {
    this.validate(req.docType, req.prefix);
    const size = req.size && req.size > 0 ? Math.min(req.size, 50) : this.defaultBlockSize;
    const block = await this.delegation.issueBlock({
      docType: req.docType,
      prefix: req.prefix,
      size,
      deviceId: req.deviceId,
    });
    if (block.quotaUsed >= block.quotaLimit) {
      throw new NumberRelayError("NUM-005", "Number quota exhausted for prefix.", 503);
    }
    const last = this.db
      .prepare("SELECT MAX(range_to) AS m FROM number_blocks WHERE doc_type=? AND prefix=?")
      .get(req.docType, req.prefix) as { m: number | null };
    if (last.m !== null && block.rangeFrom !== last.m + 1) {
      throw new NumberRelayError("NUM-007", "Delegated block is not contiguous with prefix history.");
    }
    this.db
      .prepare(
        `INSERT INTO number_blocks
          (id, doc_type, prefix, range_from, range_to, next_value, expires_at, status, quota_limit, quota_used)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        block.blockId,
        block.docType,
        block.prefix,
        block.rangeFrom,
        block.rangeTo,
        block.rangeFrom,
        block.expiresAt,
        "active",
        block.quotaLimit,
        block.quotaUsed,
      );
    return block;
  }

  async next(req: NextNumberRequest): Promise<NumberIssueResult> {
    this.validate(req.docType, req.prefix);
    if (!req.idempotencyKey || !req.deviceId) {
      throw new NumberRelayError("NUM-001", "idempotency_key and device are required.");
    }

    const existing = this.db
      .prepare("SELECT * FROM issued_numbers WHERE idempotency_key=?")
      .get(req.idempotencyKey) as IssuedRow | undefined;
    if (existing) {
      if (existing.doc_type !== req.docType || existing.prefix !== req.prefix) {
        throw new NumberRelayError("NUM-002", "Idempotency key reused for a different document.");
      }
      if (existing.status !== "issued") {
        throw new NumberRelayError("NUM-006", "Voided or abandoned numbers are never reused.", 409);
      }
      return {
        number: existing.number,
        docType: existing.doc_type,
        prefix: existing.prefix,
        blockId: existing.block_id,
        idempotencyKey: existing.idempotency_key,
        issuedAt: existing.issued_at,
      };
    }

    // PRD §29.4: CRITICAL health stops new number issuance; WARNING continues.
    const health = this.healthProvider ? await this.healthProvider() : null;
    if (health?.level === "CRITICAL") {
      throw new NumberRelayError(
        "NUM-009",
        "New document numbers are paused until data safety is reviewed.",
        503,
      );
    }
    const warning = health?.level === "WARNING" ? health.message : undefined;

    let block = this.activeBlock(req.docType, req.prefix);
    if (!block) {
      try {
        await this.issueBlock({
          docType: req.docType,
          prefix: req.prefix,
          deviceId: req.deviceId,
        });
      } catch (e) {
        if (e instanceof NumberRelayError && (e.code === "NUM-004" || e.code === "NUM-005")) throw e;
        throw new NumberRelayError("NUM-004", "Unable to obtain a delegated number block.", 503);
      }
      block = this.activeBlock(req.docType, req.prefix);
      if (!block) throw new NumberRelayError("NUM-004", "No numbers available in delegated block.", 503);
    }

    const allocated = this.db.transaction(() => {
      const fresh = this.blockById(block!.id);
      if (!fresh || fresh.status !== "active" || fresh.next_value > fresh.range_to) return null;
      const claim = this.db
        .prepare("UPDATE number_blocks SET next_value=next_value+1 WHERE id=? AND next_value=? AND status='active'")
        .run(fresh.id, fresh.next_value);
      if (claim.changes !== 1) return null;
      const number = fresh.next_value;
      const issuedAt = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO issued_numbers
            (doc_type, prefix, number, idempotency_key, block_id, device_id, status, issued_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(req.docType, req.prefix, number, req.idempotencyKey, fresh.id, req.deviceId, "issued", issuedAt);
      if (number === fresh.range_to) {
        this.db.prepare("UPDATE number_blocks SET status='exhausted' WHERE id=?").run(fresh.id);
      }
      return { number, blockId: fresh.id, issuedAt };
    })();
    if (!allocated) throw new NumberRelayError("NUM-004", "Delegated block exhausted.", 503);

    return {
      number: allocated.number,
      docType: req.docType,
      prefix: req.prefix,
      blockId: allocated.blockId,
      idempotencyKey: req.idempotencyKey,
      issuedAt: allocated.issuedAt,
      warning,
    };
  }

  async voidNumber(idempotencyKey: string): Promise<{ number: number; status: string }> {
    const row = this.db
      .prepare("SELECT * FROM issued_numbers WHERE idempotency_key=?")
      .get(idempotencyKey) as IssuedRow | undefined;
    if (!row) throw new NumberRelayError("NUM-008", "Issued number not found.", 404);
    if (row.status === "voided") return { number: row.number, status: row.status };
    if (row.status !== "issued") {
      throw new NumberRelayError("NUM-006", "Only issued numbers can be voided.", 409);
    }
    this.db.prepare("UPDATE issued_numbers SET status='voided' WHERE idempotency_key=?").run(idempotencyKey);
    return { number: row.number, status: "voided" };
  }

  async abandonBlock(blockId: string): Promise<BlockStatusView> {
    const block = this.blockById(blockId);
    if (!block) throw new NumberRelayError("NUM-008", "Delegated block not found.", 404);
    this.db.transaction(() => {
      this.db.prepare("UPDATE number_blocks SET status='abandoned' WHERE id=?").run(blockId);
      this.db
        .prepare("UPDATE issued_numbers SET status='abandoned' WHERE block_id=? AND status='issued'")
        .run(blockId);
    })();
    return this.status(blockId);
  }

  async reconcile(req: ReconcileRequest): Promise<BlockStatusView> {
    const block = this.blockById(req.blockId);
    if (!block) throw new NumberRelayError("NUM-008", "Delegated block not found.", 404);
    const at = new Date().toISOString();
    this.db.transaction(() => {
      for (const n of req.consumed) {
        this.db
          .prepare("UPDATE issued_numbers SET status='consumed', reconciled_at=? WHERE block_id=? AND number=?")
          .run(at, req.blockId, n);
      }
      for (const n of req.voided) {
        this.db
          .prepare("UPDATE issued_numbers SET status='voided', reconciled_at=? WHERE block_id=? AND number=?")
          .run(at, req.blockId, n);
      }
      const issued = this.db
        .prepare("SELECT number FROM issued_numbers WHERE block_id=?")
        .all(req.blockId) as { number: number }[];
      const seen = new Set<number>([...issued.map((r) => r.number), ...req.consumed, ...req.voided]);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO issued_numbers
          (doc_type, prefix, number, idempotency_key, block_id, device_id, status, issued_at, reconciled_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (let n = block.range_from; n <= block.range_to; n++) {
        if (seen.has(n)) continue;
        insert.run(
          block.doc_type,
          block.prefix,
          n,
          `skip:${req.blockId}:${n}`,
          req.blockId,
          "hub",
          "abandoned",
          at,
          at,
        );
      }
    })();
    await this.delegation.reconcile(req);
    return this.status(req.blockId);
  }

  status(blockId: string): BlockStatusView {
    const rows = this.db
      .prepare(
        `SELECT b.*,
            SUM(CASE WHEN i.status='issued' THEN 1 ELSE 0 END) AS issued,
            SUM(CASE WHEN i.status='voided' THEN 1 ELSE 0 END) AS voided,
            SUM(CASE WHEN i.status='abandoned' THEN 1 ELSE 0 END) AS abandoned,
            SUM(CASE WHEN i.status='consumed' THEN 1 ELSE 0 END) AS consumed
         FROM number_blocks b LEFT JOIN issued_numbers i ON i.block_id=b.id
         WHERE b.id=? GROUP BY b.id`,
      )
      .all(blockId) as (BlockRow & {
        issued: number;
        voided: number;
        abandoned: number;
        consumed: number;
      })[];
    if (rows.length === 0) throw new NumberRelayError("NUM-008", "Delegated block not found.", 404);
    return rows.map((r) => ({
      blockId: r.id,
      docType: r.doc_type,
      prefix: r.prefix,
      rangeFrom: r.range_from,
      rangeTo: r.range_to,
      nextValue: r.next_value,
      expiresAt: r.expires_at,
      status: r.status,
      quotaLimit: r.quota_limit,
      quotaUsed: r.quota_used,
      issued: r.issued,
      voided: r.voided,
      abandoned: r.abandoned,
      consumed: r.consumed,
    }))[0]!;
  }

  listStatus(): BlockStatusView[] {
    const rows = this.db
      .prepare(
        `SELECT b.*,
            SUM(CASE WHEN i.status='issued' THEN 1 ELSE 0 END) AS issued,
            SUM(CASE WHEN i.status='voided' THEN 1 ELSE 0 END) AS voided,
            SUM(CASE WHEN i.status='abandoned' THEN 1 ELSE 0 END) AS abandoned,
            SUM(CASE WHEN i.status='consumed' THEN 1 ELSE 0 END) AS consumed
         FROM number_blocks b LEFT JOIN issued_numbers i ON i.block_id=b.id
         GROUP BY b.id ORDER BY b.prefix, b.range_from`,
      )
      .all() as (BlockRow & { issued: number; voided: number; abandoned: number; consumed: number })[];
    return rows.map((r) => ({
      blockId: r.id,
      docType: r.doc_type,
      prefix: r.prefix,
      rangeFrom: r.range_from,
      rangeTo: r.range_to,
      nextValue: r.next_value,
      expiresAt: r.expires_at,
      status: r.status,
      quotaLimit: r.quota_limit,
      quotaUsed: r.quota_used,
      issued: r.issued,
      voided: r.voided,
      abandoned: r.abandoned,
      consumed: r.consumed,
    }));
  }
}

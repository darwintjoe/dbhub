import { describe, expect, it } from "vitest";
import request from "supertest";
import { addDevice, makeApp, makeCtx } from "./helpers";
import { FakeSequencerClient } from "./helpers/fake-saas";
import { NumberRelayService } from "../src/services/numbers/number-relay";
import {
  OfflineNumberDelegationClient,
  type DelegatedBlock,
  type NumberDelegationClient,
  type ReconcileRequest,
} from "../src/services/numbers/number-block-client";
import { W3_NUMBER_PATH } from "../src/services/numbers/w3-contract";

function req(key: string, extra: Record<string, unknown> = {}) {
  return { docType: "INV", prefix: "A", idempotencyKey: key, deviceId: "dev_1", ...extra };
}

class StubDelegation implements NumberDelegationClient {
  readonly name = "stub";
  constructor(private readonly make: () => DelegatedBlock) {}
  async issueBlock(): Promise<DelegatedBlock> {
    return this.make();
  }
  async blockStatus(): Promise<DelegatedBlock | null> {
    return null;
  }
  async reconcile(_req: ReconcileRequest): Promise<void> {}
}

function block(overrides: Partial<DelegatedBlock> = {}): DelegatedBlock {
  return {
    blockId: "blk_stub",
    docType: "INV",
    prefix: "A",
    rangeFrom: 1,
    rangeTo: 2,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    quotaLimit: 100,
    quotaUsed: 0,
    ...overrides,
  };
}

describe("NumberRelayService", () => {
  it("allocates gapless numbers within a prefix and replays idempotently", async () => {
    const ctx = makeCtx();
    try {
      const fake = new FakeSequencerClient();
      const relay = new NumberRelayService(ctx.db, fake);
      const first = await relay.next(req("k1"));
      const second = await relay.next(req("k2"));
      expect(first.number).toBe(1);
      expect(second.number).toBe(2);
      expect(first.blockId).toBe(second.blockId);
      expect(await relay.next(req("k1"))).toEqual(first);
      expect(fake.blocksIssued()).toHaveLength(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("drains one delegated block then delegates the next contiguous block", async () => {
    const ctx = makeCtx();
    try {
      const fake = new FakeSequencerClient();
      const relay = new NumberRelayService(ctx.db, fake, 2);
      const numbers: number[] = [];
      for (let i = 0; i < 5; i++) numbers.push((await relay.next(req(`k${i}`))).number);
      expect(numbers).toEqual([1, 2, 3, 4, 5]);
      expect(fake.blocksIssued().map((b) => [b.rangeFrom, b.rangeTo])).toEqual([
        [1, 2],
        [3, 4],
        [5, 6],
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it("stops at offline block exhaustion instead of reusing numbers", async () => {
    const ctx = makeCtx();
    try {
      ctx.db
        .prepare(
          `INSERT INTO number_blocks
            (id, doc_type, prefix, range_from, range_to, next_value, expires_at, status, quota_limit, quota_used)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run("blk_off", "INV", "A", 1, 2, 3, null, "active", 100, 0);
      const relay = new NumberRelayService(ctx.db, new OfflineNumberDelegationClient());
      await expect(relay.next(req("k_off"))).rejects.toMatchObject({ code: "NUM-004" });
    } finally {
      ctx.cleanup();
    }
  });

  it("records voided numbers and never reissues them", async () => {
    const ctx = makeCtx();
    try {
      const relay = new NumberRelayService(ctx.db, new FakeSequencerClient());
      const issued = await relay.next(req("void-key"));
      expect(await relay.voidNumber("void-key")).toEqual({ number: issued.number, status: "voided" });
      expect((await relay.status(issued.blockId)).voided).toBe(1);
      await expect(relay.next(req("void-key"))).rejects.toMatchObject({ code: "NUM-006" });
    } finally {
      ctx.cleanup();
    }
  });

  it("records abandoned blocks and their unused numbers", async () => {
    const ctx = makeCtx();
    try {
      const relay = new NumberRelayService(ctx.db, new FakeSequencerClient());
      const issued = await relay.next(req("abandon-key"));
      const view = await relay.abandonBlock(issued.blockId);
      expect(view.status).toBe("abandoned");
      expect(view.abandoned).toBeGreaterThanOrEqual(1);
      await expect(relay.next(req("abandon-key"))).rejects.toMatchObject({ code: "NUM-006" });
    } finally {
      ctx.cleanup();
    }
  });

  it("reconciles consumed/voided numbers, closes gaps as abandoned, and reports upstream", async () => {
    const ctx = makeCtx();
    try {
      const fake = new FakeSequencerClient();
      const relay = new NumberRelayService(ctx.db, fake, 3);
      const a = await relay.next(req("rec-a"));
      const b = await relay.next(req("rec-b"));
      const view = await relay.reconcile({ blockId: a.blockId, consumed: [a.number], voided: [b.number] });
      expect(view.consumed).toBe(1);
      expect(view.voided).toBe(1);
      expect(view.abandoned).toBe(1); // third number never issued
      expect(fake.reconciliations).toHaveLength(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("enforces quota and rejects non-contiguous delegated blocks", async () => {
    const ctx = makeCtx();
    try {
      const overQuota = new NumberRelayService(
        ctx.db,
        new StubDelegation(() => block({ blockId: "blk_q", quotaLimit: 10, quotaUsed: 10 })),
      );
      await expect(
        overQuota.issueBlock({ docType: "INV", prefix: "A", deviceId: "dev_1" }),
      ).rejects.toMatchObject({ code: "NUM-005" });

      const seeded = new NumberRelayService(ctx.db, new FakeSequencerClient(), 1);
      await seeded.next(req("seed"));
      const across = new NumberRelayService(
        ctx.db,
        new StubDelegation(() => block({ blockId: "blk_gap", rangeFrom: 9, rangeTo: 10 })),
      );
      await expect(
        across.issueBlock({ docType: "INV", prefix: "A", deviceId: "dev_1" }),
      ).rejects.toMatchObject({ code: "NUM-007" });
      expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM number_blocks WHERE id='blk_gap'").get()).toEqual({ c: 0 });
    } finally {
      ctx.cleanup();
    }
  });

  it("exports the deferred W3 contract path only", () => {
    expect(W3_NUMBER_PATH).toBe("/api/v1/numbers/next");
  });
});

describe("number relay HTTP endpoints", () => {
  it("serves next, block issue/status and reconcile over device auth", async () => {
    const ctx = makeCtx();
    try {
      const fake = new FakeSequencerClient();
      ctx.numberDelegation = fake;
      const d = addDevice(ctx);
      const { app } = makeApp(ctx);
      const auth = "Bearer dev-token";

      const got = await request(app)
        .get("/api/v1/numbers/next?doc_type=INV&prefix=A&idempotency_key=http1")
        .set("Authorization", auth);
      expect(got.status).toBe(200);
      expect(got.body.number).toBe(1);

      const posted = await request(app)
        .post("/api/v1/numbers/next")
        .set("Authorization", auth)
        .send({ doc_type: "INV", prefix: "A", idempotency_key: "http2" });
      expect(posted.status).toBe(200);
      expect(posted.body.number).toBe(2);
      const issuedRow = ctx.db
        .prepare("SELECT device_id FROM issued_numbers WHERE idempotency_key=?")
        .get("http2") as { device_id: string };
      expect(issuedRow.device_id).toBe(d.id);

      const listed = await request(app).get("/api/v1/numbers/block").set("Authorization", auth);
      expect(listed.status).toBe(200);
      expect(listed.body.blocks).toHaveLength(1);

      const issued = await request(app)
        .post("/api/v1/numbers/block")
        .set("Authorization", auth)
        .send({ doc_type: "INV", prefix: "B", size: 3 });
      expect(issued.status).toBe(201);
      expect(issued.body.rangeFrom).toBe(1);
      expect(issued.body.rangeTo).toBe(3);

      const status = await request(app)
        .get(`/api/v1/numbers/block/${issued.body.blockId}`)
        .set("Authorization", auth);
      expect(status.status).toBe(200);
      expect(status.body.blockId).toBe(issued.body.blockId);

      const reconciled = await request(app)
        .post("/api/v1/numbers/reconcile")
        .set("Authorization", auth)
        .send({ block_id: issued.body.blockId, consumed: [], voided: [] });
      expect(reconciled.status).toBe(200);

      const bad = await request(app)
        .get("/api/v1/numbers/next?doc_type=&prefix=A&idempotency_key=bad")
        .set("Authorization", auth);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("NUM-001");
    } finally {
      ctx.cleanup();
    }
  });
});

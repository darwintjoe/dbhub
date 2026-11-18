import { describe, expect, it } from "vitest";
import { addDevice, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { ApiError } from "../src/http/errors";
import { bundleHashFromBundle, payloadHash } from "../src/domain/hashing";

function service(ctx: ReturnType<typeof makeCtx>) {
  return new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
}

describe("ingest validation pipeline", () => {
  it("rejects malformed body", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      expect(() => service(ctx).ingest({ nope: true }, d)).toThrow(ApiError);
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects company mismatch", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const b = makeBundle(d.id, null);
      b.companyId = "cmp_other";
      expect(() => service(ctx).ingest(b, d)).toThrow(/Company mismatch/);
    } finally {
      ctx.cleanup();
    }
  });

  it("quarantines hash mismatch", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const b = makeBundle(d.id, null);
      b.payload[0].data = { tampered: true };
      expect(service(ctx).ingest(b, d)).toEqual({ status: "quarantined", reason: "hash_mismatch" });
      expect(ctx.bundles.countByStatus("quarantined")).toBe(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("dedupes by bundleId and bundleHash", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b = makeBundle(d.id, null);
      const first = svc.ingest(b, d) as { hubSeq: number };
      const dup = svc.ingest(b, d);
      expect(dup).toEqual({ status: "duplicate", hubSeq: first.hubSeq });
      expect(ctx.bundles.countByStatus("accepted")).toBe(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("quarantines duplicate event ids in payload and against events table", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b1 = makeBundle(d.id, null, 1);
      svc.ingest(b1, d);
      // Same event id in new bundle
      const b2 = makeBundle(d.id, b1.bundleHash, 2);
      b2.payload[0].id = b1.payload[0].id;
      b2.payloadHash = payloadHash(b2.payload);
      b2.bundleHash = bundleHashFromBundle(b2);
      expect(svc.ingest(b2, d)).toEqual({ status: "quarantined", reason: "duplicate_event" });
      // Duplicate inside payload
      const b3 = makeBundle(d.id, b1.bundleHash, 3);
      b3.payload.push({ ...b3.payload[0] });
      b3.eventCount = b3.payload.length;
      b3.payloadHash = payloadHash(b3.payload);
      b3.bundleHash = bundleHashFromBundle(b3);
      expect(svc.ingest(b3, d)).toEqual({ status: "quarantined", reason: "duplicate_event" });
    } finally {
      ctx.cleanup();
    }
  });

  it("quarantines device chain break when parent hash exists", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b1 = makeBundle(d.id, null, 1);
      const b2 = makeBundle(d.id, b1.bundleHash, 2);
      svc.ingest(b1, d);
      // Wrong prev, but referencing an existing hash
      b2.devicePrevHash = "0".repeat(64);
      b2.bundleId = "bdl_other";
      b2.payload[0].id = "evt_other";
      b2.payloadHash = payloadHash(b2.payload);
      b2.bundleHash = bundleHashFromBundle(b2);
      // make existing hash
      const b0 = makeBundle(d.id, null, 0);
      b0.bundleHash = "0".repeat(64);
      // direct insert for hash existence
      ctx.db.prepare("INSERT INTO bundles (bundle_id, company_id, device_id, payload_hash, bundle_hash, chain_hash, event_count, schema_version, bundle_format_version, created_at, received_at, payload_json, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        b0.bundleId, ctx.config.companyId, d.id, "x", b0.bundleHash, "x", 1, 1, 1, b0.createdAt, b0.createdAt, "[]", "quarantined",
      );
      expect(svc.ingest(b2, d)).toEqual({ status: "quarantined", reason: "device_chain_break" });
    } finally {
      ctx.cleanup();
    }
  });

  it("accepts missing parent as pending", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const b = makeBundle(d.id, "e".repeat(64));
      expect(service(ctx).ingest(b, d)).toEqual({ status: "pending_parent" });
    } finally {
      ctx.cleanup();
    }
  });
});

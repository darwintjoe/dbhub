import { describe, expect, it } from "vitest";
import { addDevice, makeBundle, makeCtx } from "./helpers";
import { IngestService } from "../src/services/ingest";
import { ApiError } from "../src/http/errors";
import { bundleHashFromBundle, payloadHash } from "../src/domain/hashing";

function service(ctx: ReturnType<typeof makeCtx>) {
  return new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
}

describe("idempotency before insert (P1-2)", () => {
  it("returns quarantined on tampered retries without a UNIQUE 500", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const tampered = makeBundle(d.id, null, 1);
      tampered.payload[0].data = { hacked: true };

      expect(svc.ingest(tampered, d)).toEqual({ status: "quarantined", reason: "hash_mismatch" });
      expect(svc.ingest(tampered, d)).toEqual({ status: "quarantined", reason: "hash_mismatch" });
      expect(ctx.bundles.countByStatus("quarantined")).toBe(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("returns quarantined after a service restart (new instance, same DB)", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const tampered = makeBundle(d.id, null, 1);
      tampered.payload[0].data = { hacked: true };
      expect(service(ctx).ingest(tampered, d)).toEqual({ status: "quarantined", reason: "hash_mismatch" });
      expect(service(ctx).ingest(tampered, d)).toEqual({ status: "quarantined", reason: "hash_mismatch" });
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects a reused bundle id with different content as 409 BUNDLE-006", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const a = makeBundle(d.id, null, 1);
      expect(svc.ingest(a, d)).toMatchObject({ status: "accepted" });

      const b = makeBundle(d.id, null, 1);
      b.bundleId = a.bundleId;
      b.payload[0].id = "evt_other";
      b.payloadHash = payloadHash(b.payload);
      b.bundleHash = bundleHashFromBundle(b);
      let err: ApiError | null = null;
      try {
        svc.ingest(b, d);
      } catch (e) {
        err = e as ApiError;
      }
      expect(err?.status).toBe(409);
      expect(err?.code).toBe("BUNDLE-006");
      expect(ctx.bundles.countAll()).toBe(1);
    } finally {
      ctx.cleanup();
    }
  });

  it("duplicate accepted retry adds no row", () => {
    const ctx = makeCtx();
    try {
      const d = addDevice(ctx);
      const svc = service(ctx);
      const b = makeBundle(d.id, null, 1);
      const first = svc.ingest(b, d) as { hubSeq: number };
      expect(svc.ingest(b, d)).toEqual({ status: "duplicate", hubSeq: first.hubSeq });
      expect(ctx.bundles.countAll()).toBe(1);
    } finally {
      ctx.cleanup();
    }
  });
});

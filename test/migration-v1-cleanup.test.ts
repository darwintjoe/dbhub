import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database";
import { BundlesRepo } from "../src/db/bundles.repo";
import { DevicesRepo } from "../src/db/devices.repo";
import { ManifestsRepo } from "../src/db/manifests.repo";
import { OutboxRepo } from "../src/db/outbox.repo";
import { AuditRepo } from "../src/db/audit.repo";
import { IngestService } from "../src/services/ingest";
import { MaintenanceService } from "../src/services/maintenance";
import { latestMigrationVersion } from "../src/db/migrations";
import { bundleHashFromBundle, payloadHash, sha256Hex } from "../src/domain/hashing";
import { makeBundle } from "./helpers";
import { createV1Fixture, deviceRow } from "./helpers/v1-fixture";

function withEventId(b: ReturnType<typeof makeBundle>, id: string) {
  b.payload[0].id = id;
  b.payloadHash = payloadHash(b.payload);
  b.bundleHash = bundleHashFromBundle(b);
  return b;
}

function eventIds(db: import("better-sqlite3").Database): string[] {
  return (db.prepare("SELECT event_id FROM events ORDER BY event_id").all() as { event_id: string }[]).map(
    (r) => r.event_id,
  );
}

describe("migration v1 → v3 cleanup (P1)", () => {
  it("cleans leaked events, backfills reservations and resolves old pending bundles", () => {
    const fixture = createV1Fixture();
    try {
      const now = new Date().toISOString();
      const insertDevice = fixture.db.prepare(
        "INSERT INTO devices (id, company_id, prefix, label, token_hash, status, created_at) VALUES (?,?,?,?,?,?,?)",
      );
      const da = deviceRow("dev_a", "A", fixture.config.companyId, sha256Hex("ta"), now);
      const dbDev = deviceRow("dev_b", "B", fixture.config.companyId, sha256Hex("tb"), now);
      for (const d of [da, dbDev]) {
        insertDevice.run(d.id, d.companyId, d.prefix, d.label, d.tokenHash, d.status, d.createdAt);
      }

      const b1 = withEventId(makeBundle("dev_a", null, 1), "evt_a1");
      const b2 = withEventId(makeBundle("dev_a", b1.bundleHash, 2), "evt_a2");
      const q1 = withEventId(makeBundle("dev_b", null, 9), "evt_b1");

      const insertBundle = fixture.db.prepare(`
        INSERT INTO bundles (
          bundle_id, company_id, device_id, user_id, period, client_prev_hash,
          payload_hash, bundle_hash, chain_hash, event_count, schema_version,
          bundle_format_version, created_at, received_at, payload_json, status,
          quarantine_reason, pending_since
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      insertBundle.run(
        b2.bundleId, fixture.config.companyId, "dev_a", "u", "2026-11", b2.devicePrevHash,
        b2.payloadHash, b2.bundleHash, b2.bundleHash, 1, 1, 1, now, now,
        JSON.stringify(b2.payload), "pending_parent", null, now,
      );
      insertBundle.run(
        q1.bundleId, fixture.config.companyId, "dev_b", "u", "2026-11", q1.devicePrevHash,
        q1.payloadHash, q1.bundleHash, q1.bundleHash, 1, 1, 1, now, now,
        JSON.stringify(q1.payload), "quarantined", "missing_parent", null,
      );
      const insertEvent = fixture.db.prepare(
        "INSERT INTO events (event_id, bundle_id, type, occurred_at, device_id) VALUES (?,?,?,?,?)",
      );
      insertEvent.run("evt_a2", b2.bundleId, "journal.posted", null, "dev_a");
      insertEvent.run("evt_b1", q1.bundleId, "journal.posted", null, "dev_b");
      fixture.db.close();

      const config = fixture.config;
      const db = openDatabase(config);
      try {
        const bundles = new BundlesRepo(db);
        const devices = new DevicesRepo(db);
        const maintenance = new MaintenanceService(db, bundles, config);
        const ingest = new IngestService(
          db, config, bundles, devices, new ManifestsRepo(db), new OutboxRepo(db), new AuditRepo(db),
        );

        expect(db.pragma("user_version", { simple: true })).toBe(latestMigrationVersion());
        expect(eventIds(db)).toEqual([]);
        expect(db.prepare("SELECT event_id, bundle_id FROM pending_event_ids").all()).toEqual([
          { event_id: "evt_a2", bundle_id: b2.bundleId },
        ]);
        expect(maintenance.verifyChain()).toEqual({ ok: true, checked: 0 });

        const deviceA = devices.findById("dev_a")!;
        expect(ingest.ingest(b1, deviceA)).toMatchObject({ status: "accepted" });
        expect(bundles.findByBundleId(b2.bundleId)?.status).toBe("accepted");
        expect(eventIds(db)).toEqual(["evt_a1", "evt_a2"]);
        expect(db.prepare("SELECT COUNT(*) AS c FROM pending_event_ids").get()).toEqual({ c: 0 });
        expect(maintenance.verifyChain()).toEqual({ ok: true, checked: 2 });

        const freshB = withEventId(makeBundle("dev_b", null, 3), "evt_b1");
        const deviceB = devices.findById("dev_b")!;
        expect(ingest.ingest(freshB, deviceB)).toMatchObject({ status: "accepted" });
        expect(eventIds(db)).toEqual(["evt_a1", "evt_a2", "evt_b1"]);

        const before = {
          events: eventIds(db).length,
          reservations: (db.prepare("SELECT COUNT(*) AS c FROM pending_event_ids").get() as { c: number }).c,
          accepted: bundles.countByStatus("accepted"),
        };
        db.close();

        const db2 = openDatabase(config);
        try {
          expect(db2.pragma("user_version", { simple: true })).toBe(latestMigrationVersion());
          expect(eventIds(db2).length).toBe(before.events);
          expect((db2.prepare("SELECT COUNT(*) AS c FROM pending_event_ids").get() as { c: number }).c).toBe(before.reservations);
          expect(new BundlesRepo(db2).countByStatus("accepted")).toBe(before.accepted);
        } finally {
          db2.close();
        }
      } finally {
        try {
          if (db.open) db.close();
        } catch {
          // already closed
        }
      }
    } finally {
      fixture.cleanup();
    }
  });
});



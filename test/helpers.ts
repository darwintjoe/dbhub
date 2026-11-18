import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/database";
import { DevicesRepo } from "../src/db/devices.repo";
import { BundlesRepo } from "../src/db/bundles.repo";
import { ManifestsRepo } from "../src/db/manifests.repo";
import { OutboxRepo } from "../src/db/outbox.repo";
import { AuditRepo } from "../src/db/audit.repo";
import type { Config } from "../src/config";
import type { BundleV1, DeviceRow } from "../src/domain/types";
import { bundleHashFromBundle, payloadHash, sha256Hex } from "../src/domain/hashing";

export interface TestCtx {
  db: Database.Database;
  config: Config;
  devices: DevicesRepo;
  bundles: BundlesRepo;
  manifests: ManifestsRepo;
  outbox: OutboxRepo;
  audit: AuditRepo;
  cleanup: () => void;
}

export function makeConfig(dataDir: string): Config {
  return {
    companyId: "cmp_test",
    replicaId: "hub_test",
    port: 8787,
    host: "127.0.0.1",
    adminTokenHash: sha256Hex("admin-token"),
    dataDir,
    logDir: path.join(dataDir, "logs"),
    storage: { target: "null", folderPath: "" },
    limits: { maxBodyBytes: 5242880, ratePerMinutePerDevice: 1000, ratePerMinutePerIp: 1000 },
    quarantine: { pendingParentTimeoutMs: 1000 },
  };
}

export function makeCtx(): TestCtx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fazai-hub-test-"));
  const config = makeConfig(dir);
  const db = openDatabase(config);
  return {
    db,
    config,
    devices: new DevicesRepo(db),
    bundles: new BundlesRepo(db),
    manifests: new ManifestsRepo(db),
    outbox: new OutboxRepo(db),
    audit: new AuditRepo(db),
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function addDevice(ctx: TestCtx, id = "dev_1", token = "dev-token"): DeviceRow {
  const device: DeviceRow = {
    id,
    companyId: ctx.config.companyId,
    prefix: id,
    label: "Test",
    tokenHash: sha256Hex(token),
    status: "approved",
    createdAt: "2026-11-01T00:00:00.000Z",
    lastSeenAt: null,
  };
  ctx.devices.create(device);
  return device;
}

import express from "express";
import { IngestService } from "../src/services/ingest";
import { BatchingService } from "../src/services/batching";
import { MaintenanceService } from "../src/services/maintenance";
import { NullTarget } from "../src/services/replica/null-target";
import { requireAdmin, requireDevice, requireDeviceOrAdmin } from "../src/http/auth";
import { errorHandler } from "../src/http/errors";
import { statusHandler } from "../src/http/routes/status";
import { devicesRoutes } from "../src/http/routes/devices";
import { relayRoutes } from "../src/http/routes/relay";
import { pullRoutes } from "../src/http/routes/pull";
import { manifestRoutes } from "../src/http/routes/manifest";
import { quarantineRoutes } from "../src/http/routes/quarantine";
import { maintenanceRoutes } from "../src/http/routes/maintenance";
import { uiHandler } from "../src/http/ui";

export function makeApp(ctx: TestCtx) {
  const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
  const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, new NullTarget(), ctx.config);
  const maintenance = new MaintenanceService(ctx.db, ctx.bundles, ctx.config);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: ctx.config.limits.maxBodyBytes }));
  app.use((req, res, next) => {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const ct = req.header("content-type") || "";
      if (!ct.includes("application/json")) {
        res.status(415).json({ error: { code: "BUNDLE-001", message: "Content-Type must be application/json.", details: {} } });
        return;
      }
    }
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true, version: "0.1.1" }));
  app.get("/", uiHandler(ctx.config, ctx.bundles, ctx.devices));
  app.get("/api/v1/status", requireDeviceOrAdmin(ctx.config, ctx.devices), statusHandler(ctx.config, ctx.bundles, ctx.devices));
  app.use("/api/v1/admin", requireAdmin(ctx.config));
  app.use("/api/v1/admin/devices", devicesRoutes(ctx.config, ctx.devices, ctx.audit));
  app.use("/api/v1/admin/quarantine", quarantineRoutes(ctx.bundles));
  app.use("/api/v1/admin/maintenance", maintenanceRoutes(maintenance, ctx.outbox));
  app.use("/api/v1/relay", requireDevice(ctx.devices), relayRoutes(ingest, ctx.devices));
  app.use("/api/v1/pull", requireDevice(ctx.devices), pullRoutes(ctx.bundles));
  app.use("/api/v1/manifest", requireDevice(ctx.devices), manifestRoutes(ctx.config, ctx.manifests));
  app.use(errorHandler);
  return { app, batching, maintenance, ingest };
}

export function makeBundle(deviceId: string, prev: string | null, seq = 1): BundleV1 {
  const payload = [{ id: `evt_${deviceId}_${seq}`, type: "journal.posted", schemaVersion: 1, data: { seq } }];
  const b: BundleV1 = {
    bundleId: `bdl_${deviceId}_${seq}`,
    companyId: "cmp_test",
    ledgerStreamId: "main",
    deviceId,
    userId: "u1",
    period: "2026-11",
    devicePrevHash: prev,
    payloadHash: "",
    bundleHash: "",
    eventCount: 1,
    schemaVersion: 1,
    bundleFormatVersion: 1,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(),
    payload,
  };
  b.payloadHash = payloadHash(payload);
  b.bundleHash = bundleHashFromBundle(b);
  return b;
}

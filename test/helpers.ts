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
  numberDelegation?: import("../src/services/numbers/number-block-client").NumberDelegationClient;
  storageAdapter?: import("../src/services/replica/storage-adapter").StorageAdapter;
  recovery?: RecoveryService;
  replicaHealth?: ReplicaHealthService;
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
    storage: { target: "null", folderPath: "", adapter: "null" },
    saas: { baseUrl: "", profile: "solo", hubOrigin: false, deviceTokenFile: "", timeoutMs: 10000 },
    googleDrive: { clientId: "", tokenPath: "", scopes: ["https://www.googleapis.com/auth/drive.file"] },
    limits: { maxBodyBytes: 5242880, ratePerMinutePerDevice: 1000, ratePerMinutePerIp: 1000, ratePerMinutePerAdmin: 1000 },
    quarantine: { pendingParentTimeoutMs: 1000 },
    publicUrl: "",
    monitoring: { enabled: true, sampleIntervalMs: 5000, historyPoints: 120, hostCounters: true },
    backup: { dir: "", retentionDays: 14, maxFiles: 20 },
    security: { trustProxy: false, adminAllowedCidrs: [], allowedOrigins: [] },
    connectivity: { mode: "lan", publicUrl: "", publicDomain: "hub.example.com", publicPort: 8788, cloudflare: { binaryPath: "cloudflared", tunnelTokenFile: "", autoStart: false }, mdns: { enabled: true } },
  };
}

export function makeCtx(): TestCtx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbhub-test-"));
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
import { rateLimitMiddleware } from "../src/http/rate-limit";
import { ConfigService } from "../src/services/config-service";
import { MetricsSampler } from "../src/services/metrics/sampler";
import { RequestMetrics } from "../src/services/metrics/registry";
import { OverviewService } from "../src/services/overview";
import { HealthService } from "../src/services/health";
import { BackupService } from "../src/services/backup";
import { adminExtraRoutes } from "../src/http/routes/admin-extra";
import { statusHandler } from "../src/http/routes/status";
import { devicesRoutes } from "../src/http/routes/devices";
import { relayRoutes } from "../src/http/routes/relay";
import { numberRoutes } from "../src/http/routes/numbers";
import { recoveryRoutes } from "../src/http/routes/recovery";
import { NumberRelayService } from "../src/services/numbers/number-relay";
import { OfflineNumberDelegationClient } from "../src/services/numbers/number-block-client";
import { createStorageAdapter } from "../src/services/replica/storage-adapter";
import { RecoveryService } from "../src/services/replica/recovery";
import { ReplicaHealthService } from "../src/services/replica/replica-health";
import { pullRoutes } from "../src/http/routes/pull";
import { manifestRoutes } from "../src/http/routes/manifest";
import { quarantineRoutes } from "../src/http/routes/quarantine";
import { maintenanceRoutes } from "../src/http/routes/maintenance";
import { uiHandler } from "../src/http/ui";

export function makeApp(ctx: TestCtx) {
  const ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
  const batching = new BatchingService(ctx.db, ctx.bundles, ctx.manifests, ctx.outbox, new NullTarget(), ctx.config);
  const maintenance = new MaintenanceService(ctx.db, ctx.bundles, ctx.config);
  const storageAdapter = ctx.storageAdapter ?? createStorageAdapter({
    ...ctx.config.storage,
    googleDrive: ctx.config.googleDrive,
    companyId: ctx.config.companyId,
    replicaId: ctx.config.replicaId,
  });
  const recovery = ctx.recovery ?? new RecoveryService(
    ctx.db, ctx.config, ctx.bundles, ctx.manifests, storageAdapter, maintenance,
  );
  const replicaHealth = ctx.replicaHealth ?? new ReplicaHealthService({
    config: ctx.config,
    bundles: ctx.bundles,
    manifests: ctx.manifests,
    adapter: storageAdapter,
    chainVerify: () => maintenance.lastVerify,
  });
  const numberRelay = new NumberRelayService(
    ctx.db,
    ctx.numberDelegation ?? new OfflineNumberDelegationClient(),
    20,
    () => replicaHealth.check(),
  );
  const configPath = path.join(ctx.config.dataDir, "config.json");
  try {
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(ctx.config, null, 2) + "\n");
    }
  } catch { /* ignore */ }
  const configService = new ConfigService({ path: configPath, config: ctx.config, audit: ctx.audit });
  const fakeHost = {
    available: true,
    async sample() { return { available: true, hostname: "test", platform: process.platform, release: "1", arch: "x64", cpuModel: "cpu", cpuCores: 1, cpuLogical: 1, cpuSpeedMhz: 1, loadAvg: [0], cpuPercentTotal: 1, cpuPercentPerCore: [1], memoryTotalBytes: 1000, memoryFreeBytes: 500, memoryUsedBytes: 500, swapTotalBytes: null, swapFreeBytes: null, uptimeSec: 1, disks: [{ mount: "/", totalBytes: 1000, freeBytes: 500, usedBytes: 500, usedPercent: 50 }], network: [], sampledAt: new Date().toISOString() }; },
    async hardware() { return { available: true, cpu: { model: "cpu", cores: 1, logical: 1, speedMhz: 1 }, memoryModules: [], physicalDisks: [], logicalVolumes: [], nics: [], os: { caption: "test", version: "1" }, cachedAt: new Date().toISOString() }; },
  };
  const requestMetrics = new RequestMetrics();
  const metricsSampler = new MetricsSampler({
    config: ctx.config,
    hostAdapter: fakeHost as any,
    dbStatsProvider: () => ({ counts: { accepted: ctx.bundles.countByStatus("accepted") } }),
    serviceStatsProvider: () => ({ health: "ok" }),
    requestMetrics,
    activeConnectionsProvider: () => 0,
  });
  const backupService = new BackupService(ctx.db, ctx.config);
  const healthService = new HealthService({ config: ctx.config, db: ctx.db, bundles: ctx.bundles, outbox: ctx.outbox, serverListening: () => true, serviceStatsProvider: () => ({ batchingLastErrorAt: null, lastChainVerify: null }), onHealthStatus: () => {} });
  const stubTunnel = {
    getStatus: () => ({ status: "disabled", publicUrl: "", lastError: null, lastStartAt: null, restartCount: 0, pid: null }),
  };
  const overviewService = new OverviewService({ config: ctx.config, configService, healthService, bundles: ctx.bundles, devices: ctx.devices, outbox: ctx.outbox, metricsSampler, backupService, tunnel: stubTunnel as any, maintenance, replicaHealthProvider: () => replicaHealth.check() });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: ctx.config.limits.maxBodyBytes }));
  app.use((req, res, next) => {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const ct = req.header("content-type") || "";
      const cl = req.header("content-length");
      const hasBody = cl !== undefined && cl !== "0";
      const isRelay = req.path.startsWith("/api/v1/relay");
      if (hasBody && !ct.includes("application/json") && (isRelay || req.path.startsWith("/api/v1/admin"))) {
        res.status(415).json({ error: { code: "BUNDLE-001", message: "Content-Type must be application/json.", details: {} } });
        return;
      }
    }
    next();
  });
  app.use(rateLimitMiddleware(ctx.config));
  app.get("/healthz", (_req, res) => res.json({ ok: true, version: "0.3.0" }));
  app.get("/", uiHandler(ctx.config, ctx.bundles, ctx.devices));
  app.get("/api/v1/status", requireDeviceOrAdmin(ctx.config, ctx.devices), statusHandler(ctx.config, ctx.bundles, ctx.devices, () => replicaHealth.check()));
  app.use("/api/v1/admin", requireAdmin(ctx.config));
  app.use("/api/v1/admin/devices", devicesRoutes(ctx.config, ctx.devices, ctx.audit, ctx.bundles));
  app.use("/api/v1/admin/quarantine", quarantineRoutes(ctx.bundles));
  app.use("/api/v1/admin/recovery", recoveryRoutes(recovery));
  app.use("/api/v1/admin/maintenance", maintenanceRoutes(maintenance, ctx.outbox));
  app.use("/api/v1/admin", adminExtraRoutes({ config: ctx.config, configService, metricsSampler, overviewService, healthService, backupService, audit: ctx.audit, db: ctx.db, bundles: ctx.bundles, devices: ctx.devices, outbox: ctx.outbox, maintenance, logDir: ctx.config.logDir }));
  app.use("/api/v1/relay", requireDevice(ctx.devices), relayRoutes(ingest, ctx.devices));
  app.use("/api/v1/numbers", requireDevice(ctx.devices), numberRoutes(numberRelay));
  app.use("/api/v1/pull", requireDevice(ctx.devices), pullRoutes(ctx.bundles));
  app.use("/api/v1/manifest", requireDevice(ctx.devices), manifestRoutes(ctx.config, ctx.manifests));
  app.use(errorHandler);
  return { app, batching, numberRelay, recovery, replicaHealth, maintenance, ingest, configService, metricsSampler };
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

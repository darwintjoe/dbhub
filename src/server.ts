import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { openDatabase } from "./db/database";
import { BundlesRepo } from "./db/bundles.repo";
import { DevicesRepo } from "./db/devices.repo";
import { ManifestsRepo } from "./db/manifests.repo";
import { OutboxRepo } from "./db/outbox.repo";
import { AuditRepo } from "./db/audit.repo";
import { IngestService } from "./services/ingest";
import { BatchingService } from "./services/batching";
import { MaintenanceService } from "./services/maintenance";
import { NullTarget } from "./services/replica/null-target";
import { FolderTarget } from "./services/replica/folder-target";
import { createSequencerClient } from "./services/saas/sequencer-client";
import { requireAdmin, requireDevice, requireDeviceOrAdmin } from "./http/auth";
import { rateLimitMiddleware } from "./http/rate-limit";
import { createErrorHandler } from "./http/errors";
import { statusHandler } from "./http/routes/status";
import { devicesRoutes } from "./http/routes/devices";
import { relayRoutes } from "./http/routes/relay";
import { pullRoutes } from "./http/routes/pull";
import { manifestRoutes } from "./http/routes/manifest";
import { quarantineRoutes } from "./http/routes/quarantine";
import { maintenanceRoutes } from "./http/routes/maintenance";
import { uiHandler } from "./http/ui";
import { VERSION } from "./domain/types";
import { ConfigService } from "./services/config-service";
import { createHostAdapter } from "./services/metrics/host-windows";
import { MetricsSampler } from "./services/metrics/sampler";
import { RequestMetrics } from "./services/metrics/registry";
import { OverviewService } from "./services/overview";
import { HealthService } from "./services/health";
import { BackupService } from "./services/backup";
import { adminExtraRoutes } from "./http/routes/admin-extra";
import { adminCidrMiddleware } from "./http/cidr";
import { createAdminApp, createPublicApp } from "./app";
import { generateFirstRunSetupCode } from "./services/setup-code";
import { isDevNoAuth } from "./http/dev-no-auth";
import { MdnsService } from "./services/mdns";
import { CloudflareTunnelProvider } from "./services/cloudflare-tunnel";
export { createAdminApp, createPublicApp, createApp, createServer, buildServer, buildAdminApp, buildPublicApp, buildApp } from "./app";

export async function startServices(config: any, db: any, logger: any, overrides: any = {}) {
  const MdnsCtor = overrides.MdnsService ?? (await import("./services/mdns")).MdnsService;
  const TunnelCtor = overrides.CloudflareTunnelProvider ?? (await import("./services/cloudflare-tunnel")).CloudflareTunnelProvider;
  const mdns = overrides.mdns ?? new MdnsCtor({
    serial: config.replicaId,
    port: config.port,
    enabled: Boolean(config.connectivity?.mdns?.enabled),
    company: config.companyId,
    setupRequired: () => {
      try { return !db.prepare("SELECT 1 FROM admin_credentials WHERE id=1").get(); } catch { return false; }
    },
  });
  const tunnel = overrides.tunnel ?? new TunnelCtor({ config });
  const handles: any = { mdns, tunnel, publicServer: null };
  if (config.connectivity?.mode === "cloudflare" && config.connectivity?.cloudflare?.autoStart) {
    try { await tunnel.start(); } catch (e) { logger?.warn?.({ err: e }, "tunnel start failed"); }
  }
  if (config.connectivity?.mdns?.enabled) {
    try { await mdns.start(); } catch (e) { logger?.warn?.({ err: e }, "mdns start failed"); }
  }
  // error event handling
  try { mdns.on?.("error", () => {}); } catch {}
  if (config.connectivity?.mode === "cloudflare" && overrides.publicApp) {
    const port = config.connectivity.publicPort || 8788;
    handles.publicServer = overrides.publicApp.listen(port, "127.0.0.1", () => {});
  }
  return handles;
}

async function main() {
  const { config, path: configPath } = loadConfig();
  const logger = createLogger(config);
  logger.info({ configPath, dataDir: config.dataDir, version: VERSION }, "starting dbhub");
  if (isDevNoAuth()) {
    logger.warn("DBHUB_DEV_NO_AUTH is enabled — admin API is open without credentials. Development only; never use in production.");
  }

  const db = openDatabase(config);
  // First-run setup code generation (stdout + protected file only).
  // Skipped in dev no-auth mode: no setup/login is needed and no code is emitted.
  if (!isDevNoAuth()) generateFirstRunSetupCode(db, config.dataDir);

  const bundles = new BundlesRepo(db);
  const devices = new DevicesRepo(db);
  const manifests = new ManifestsRepo(db);
  const outbox = new OutboxRepo(db);
  const audit = new AuditRepo(db);

  const target =
    config.storage.target === "folder"
      ? new FolderTarget(config.storage.folderPath)
      : new NullTarget();

  const ingest = new IngestService(db, config, bundles, devices, manifests, outbox, audit);
  const sequencer = createSequencerClient(config.saas);
  const batching = new BatchingService(db, bundles, manifests, outbox, target, config, 300_000, sequencer);
  const maintenance = new MaintenanceService(db, bundles, config);

  const configService = new ConfigService({ path: configPath, config, audit });
  const serviceState = { healthStatus: "ok" };
  const hostAdapter = createHostAdapter(config);
  const requestMetrics = new RequestMetrics();
  let serverRef: any = null;
  const backupService = new BackupService(db, config);
  const tunnel = new (await import("./services/cloudflare-tunnel")).CloudflareTunnelProvider({ config });
  const metricsSampler = new MetricsSampler({
    config,
    hostAdapter,
    dbStatsProvider: () => ({
      hubBytes: safeSize(path.join(config.dataDir, "hub.sqlite")),
      walBytes: safeSize(path.join(config.dataDir, "hub.sqlite-wal")),
      shmBytes: safeSize(path.join(config.dataDir, "hub.sqlite-shm")),
      pageCount: safePragma(db, "page_count"),
      pageSize: safePragma(db, "page_size"),
      freelistCount: safePragma(db, "freelist_count"),
      journalMode: safePragmaStr(db, "journal_mode"),
      userVersion: safePragma(db, "user_version"),
      counts: {
        accepted: bundles.countByStatus("accepted"),
        pendingParent: bundles.countByStatus("pending_parent"),
        quarantined: bundles.countByStatus("quarantined"),
        quarantinedByReason: quarantineByReason(bundles),
        events: bundles.countEvents(),
        bundles: bundles.countAll(),
      },
      oldestPendingParentAgeMs: oldestPendingAge(db),
      lastAcceptedReceivedAt: bundles.lastReceivedAt(),
    }),
    serviceStatsProvider: () => {
      const backups = backupService.list();
      return {
        health: serviceState.healthStatus,
        listening: Boolean(serverRef?.listening),
        lastIngestAt: bundles.lastReceivedAt(),
        batchingLastRunAt: batching.lastRunAt,
        batchingLastErrorAt: batching.lastErrorAt,
        maintenanceLastSweepAt: maintenance.lastSweepAt,
        lastChainVerify: maintenance.lastVerify,
        lastChainVerifyAt: maintenance.lastVerifyAt,
        lastCheckpointAt: maintenance.lastCheckpointAt,
        lastBackupAt: backups.length ? new Date(backups[0]!.mtimeMs).toISOString() : null,
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        windowsServiceState: "unknown",
        ingestCount: bundles.countAll(),
        // No reliable connection-tracking source in v0; documented as 0.
        activeConnections: 0,
      };
    },
    outboxProvider: () => ({
      counts: outbox.counts() as any,
      oldestPendingAgeMs: outbox.oldestPendingAgeMs(),
      lastSuccessAt: outbox.lastSuccessAt(),
    }),
    devicesProvider: () => {
      const rows = devices.list(config.companyId);
      const cutoff = Date.now() - 5 * 60 * 1000;
      const online = rows.filter((d) => d.lastSeenAt && Date.parse(d.lastSeenAt) >= cutoff).length;
      return { online, total: rows.length };
    },
    requestMetrics,
    activeConnectionsProvider: () => 0,
  });

  const healthService = new HealthService({ config, db, bundles, outbox, serverListening: () => Boolean(serverRef?.listening), onHealthStatus: (s) => { serviceState.healthStatus = s; }, serviceStatsProvider: () => ({ batchingLastErrorAt: batching.lastErrorAt, lastChainVerify: maintenance.lastVerify }) });
  const overviewService = new OverviewService({ config, configService, healthService, bundles, devices, outbox, metricsSampler, backupService, tunnel, maintenance });

  const mdns = new (await import("./services/mdns")).MdnsService({
    serial: config.replicaId,
    port: config.port,
    enabled: Boolean(config.connectivity?.mdns?.enabled),
    company: config.companyId,
    setupRequired: () => {
      try { return !db.prepare("SELECT 1 FROM admin_credentials WHERE id=1").get(); } catch { return false; }
    },
  });

  const ctx = {
    config,
    db,
    devices,
    bundles,
    manifests,
    outbox,
    audit,
    configService,
    ingest,
    batching,
    maintenance,
    metricsSampler,
    requestMetrics,
    hostAdapter,
    serviceState,
    healthService,
    overviewService,
    backupService,
    tunnel,
    logger,
  };
  const app = createAdminApp(ctx);
  const publicApp = createPublicApp(ctx);

  const handles = await startServices(config, db, logger, { publicApp, tunnel, mdns });

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, "listening");
  });
  serverRef = server;

  let publicServer = null;
  if (config.connectivity?.mode === "cloudflare") {
    const publicPort = config.connectivity.publicPort || 8788;
    publicServer = publicApp.listen(publicPort, "127.0.0.1", () => {
      logger.info({ host: "127.0.0.1", port: publicPort }, "public listener listening");
    });
  }

  batching.resetOnStartup();
  batching.start();
  maintenance.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (publicServer) await new Promise<void>((resolve) => publicServer.close(() => resolve()));
    try {
      await mdns.stop();
      await tunnel.stop();
      await batching.stop();
      maintenance.stop();
      maintenance.checkpoint();
      db.close();
    } catch (e) {
      logger.error({ err: e }, "shutdown error");
    }
    clearTimeout(force);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    logger.fatal({ err: e }, "uncaughtException");
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logger.fatal({ err: e }, "unhandledRejection");
    process.exit(1);
  });
}

function safeSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}
function safePragma(db: any, key: string): number {
  try { return Number(db.pragma(`${key}`, { simple: true })); } catch { return 0; }
}
function safePragmaStr(db: any, key: string): string {
  try { return String(db.pragma(`${key}`, { simple: true })); } catch { return ""; }
}
function quarantineByReason(bundles: BundlesRepo): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const rows = (bundles as any).db?.prepare?.("SELECT quarantine_reason, COUNT(*) AS c FROM bundles WHERE status='quarantined' GROUP BY quarantine_reason").all() as any[];
    for (const r of rows ?? []) out[String(r.quarantine_reason ?? "unknown")] = r.c;
  } catch { /* ignore */ }
  return out;
}
function oldestPendingAge(db: any): number | null {
  try {
    const row = db.prepare("SELECT MIN(created_at) AS m FROM bundles WHERE status='pending_parent'").get() as { m: string | null };
    if (!row?.m) return null;
    return Date.now() - Date.parse(row.m);
  } catch { return null; }
}

if (require.main === module) void main();

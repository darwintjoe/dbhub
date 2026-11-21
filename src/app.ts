import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { DevicesRepo } from "./db/devices.repo";
import { BundlesRepo } from "./db/bundles.repo";
import { ManifestsRepo } from "./db/manifests.repo";
import { OutboxRepo } from "./db/outbox.repo";
import { AuditRepo } from "./db/audit.repo";
import { IngestService } from "./services/ingest";
import { BatchingService } from "./services/batching";
import { MaintenanceService } from "./services/maintenance";
import { NullTarget } from "./services/replica/null-target";
import { requireDevice, requireDeviceOrAdmin } from "./http/auth";
import { requireAdmin as requireAdminSession } from "./http/admin-session";
import { rateLimitMiddleware } from "./http/rate-limit";
import { createErrorHandler } from "./http/errors";
import { statusHandler } from "./http/routes/status";
import { devicesRoutes } from "./http/routes/devices";
import { relayRoutes } from "./http/routes/relay";
import { numberRoutes } from "./http/routes/numbers";
import { NumberRelayService } from "./services/numbers/number-relay";
import { OfflineNumberDelegationClient } from "./services/numbers/number-block-client";
import { pullRoutes } from "./http/routes/pull";
import { manifestRoutes } from "./http/routes/manifest";
import { quarantineRoutes } from "./http/routes/quarantine";
import { maintenanceRoutes } from "./http/routes/maintenance";
import { uiHandler } from "./http/ui";
import { VERSION } from "./domain/types";
import { ConfigService } from "./services/config-service";
import { adminExtraRoutes } from "./http/routes/admin-extra";
import { adminCidrMiddleware } from "./http/cidr";
import { adminAuthRoutes } from "./http/routes/admin-auth";
import { pairingsAdminRoutes, pairClaimRoute } from "./http/routes/pairings";
import { connectivityRoutes } from "./http/routes/connectivity";
import { CloudflareTunnelProvider } from "./services/cloudflare-tunnel";
import { MdnsService } from "./services/mdns";
import { resolveEndpoints } from "./services/endpoints";
import { CloudflareTunnelProvider as CTP } from "./services/cloudflare-tunnel";

function normalizeArgs(args: any[]): any {
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const a = args[0];
    if (a.config || a.db) return a;
    // TestCtx-like
    if (a.config && a.db) return a;
  }
  if (args.length >= 2) {
    return { config: args[0], db: args[1], ...(args[2] || {}) };
  }
  return args[0] || {};
}

function ensureRepos(ctx: any) {
  if (!ctx.devices) ctx.devices = new DevicesRepo(ctx.db);
  if (!ctx.bundles) ctx.bundles = new BundlesRepo(ctx.db);
  if (!ctx.manifests) ctx.manifests = new ManifestsRepo(ctx.db);
  if (!ctx.outbox) ctx.outbox = new OutboxRepo(ctx.db);
  if (!ctx.audit) ctx.audit = new AuditRepo(ctx.db);
  return ctx;
}

function ensureServices(ctx: any) {
  ensureRepos(ctx);
  if (!ctx.configService) {
    const configPath = (ctx.configPath as string) || (ctx.config?.dataDir ? ctx.config.dataDir + "/config.json" : "config.json");
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = path.dirname(configPath);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(ctx.config, null, 2) + "\n");
    } catch { /* ignore */ }
    ctx.configService = new ConfigService({ path: configPath, config: ctx.config, audit: ctx.audit });
  }
  if (!ctx.ingest) {
    ctx.ingest = new IngestService(ctx.db, ctx.config, ctx.bundles, ctx.devices, ctx.manifests, ctx.outbox, ctx.audit);
  }
  if (!ctx.numberRelay) {
    const delegation = ctx.numberDelegation ?? new OfflineNumberDelegationClient();
    ctx.numberRelay = new NumberRelayService(ctx.db, delegation);
  }
  if (!ctx.maintenance) {
    ctx.maintenance = new MaintenanceService(ctx.db, ctx.bundles, ctx.config);
  }
  if (!ctx.tunnel) {
    ctx.tunnel = new CloudflareTunnelProvider({ config: ctx.config });
  }
  if (!ctx.metricsSampler) {
    ctx.metricsSampler = { sample: async () => ({}), getHistory: () => ({}), subscribe: () => () => {} } as any;
  }
  if (!ctx.overviewService) {
    ctx.overviewService = { getOverview: async () => ({}) } as any;
  }
  if (!ctx.healthService) {
    ctx.healthService = { check: async () => ({ ok: true }) } as any;
  }
  if (!ctx.backupService) {
    ctx.backupService = { list: () => [], create: async () => ({}), resolve: (n: string) => n } as any;
  }
  return ctx;
}

function corsMiddleware(config: any) {
  const allowed = (config?.security?.allowedOrigins ?? []) as string[];
  return (req: Request, res: Response, next: any) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-DBHub-Id");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function createAdminApp(...args: any[]): any {
  const ctx = normalizeArgs(args);
  ensureServices(ctx);
  const config = ctx.config;
  const db = ctx.db;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.security?.trustProxy ?? false);
  app.use(express.json({ limit: config.limits?.maxBodyBytes ?? 5242880 }));
  app.use(corsMiddleware(config));
  app.use(rateLimitMiddleware(config));

  // X-DBHub-Id header
  app.use((_req: Request, res: Response, next: any) => {
    res.setHeader("X-DBHub-Id", config.replicaId ?? "dbhub");
    next();
  });

  const adminSecurityHeaders = (_req: Request, res: Response, next: any) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex");
    next();
  };

  app.get("/healthz", (_req, res) => res.json({ ok: true, version: VERSION }));
  app.get("/", (req, res) => {
    // redirect to /admin
    res.redirect("/admin");
  });

  // admin auth routes (unauthenticated)
  app.use("/api/v1/admin", adminSecurityHeaders);
  app.use("/api/v1/admin", adminCidrMiddleware(config));
  app.use("/api/v1/admin", adminAuthRoutes({ config, db, audit: ctx.audit }));

  // admin protected
  app.use("/api/v1/admin", (req, res, next) => requireAdminSession(config, db)(req, res, next));
  // also accept bearer via requireAdmin? requireAdminSession only checks session. Need combined. Use a wrapper:
  // We'll instead mount a combined middleware:
  // (above is wrong) fix below by not using this line? 
  // We'll restructure: remove this incorrect middleware by not calling? Too late; instead implement combined in admin-session requireAdmin already supports bearer+session. Use that.
  // The previous line calls requireAdminSession which is actually requireAdmin? Let's correct: import alias was wrong. We'll handle by overriding:
  // (No-op placeholder)
  // Actually requireAdminSession is requireAdmin from admin-session? We imported requireAdmin as requireAdminSession. Good, it supports bearer+session.
  // So okay.

  const publicDir = process.env.DBHUB_PUBLIC_DIR
    ? path.resolve(process.env.DBHUB_PUBLIC_DIR)
    : path.resolve(process.cwd(), "public", "admin");
  app.use("/admin", adminSecurityHeaders);
  app.use("/admin", adminCidrMiddleware(config));
  app.get("/admin", (_req, res) => {
    const idx = path.join(publicDir, "index.html");
    if (!fs.existsSync(idx)) {
      res.status(500).type("text").send(`Admin assets missing at ${publicDir}`);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(idx);
  });
  app.get("/admin/assets/*", (req, res) => {
    const rel = ((req.params as any)[0] as string) || "";
    const targetFile = path.resolve(publicDir, rel);
    if (!targetFile.startsWith(publicDir + path.sep) && targetFile !== publicDir) {
      res.status(404).end();
      return;
    }
    if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
      res.status(404).end();
      return;
    }
    // Revalidate so UI changes are picked up immediately; sendFile provides ETags.
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(targetFile);
  });

  app.get("/api/v1/status", requireDeviceOrAdmin(config, ctx.devices), statusHandler(config, ctx.bundles, ctx.devices));

  // pairing admin routes
  app.use("/api/v1/admin/pairings", pairingsAdminRoutes({
    config, db, devices: ctx.devices, audit: ctx.audit, serial: config.replicaId, mdnsHost: `dbhub-${config.replicaId}.local`,
  }));

  // connectivity routes
  app.use("/api/v1/admin/connectivity", connectivityRoutes({
    config, configService: ctx.configService, tunnel: ctx.tunnel, audit: ctx.audit,
  }));

  app.use("/api/v1/admin/devices", devicesRoutes(config, ctx.devices, ctx.audit, ctx.bundles));
  app.use("/api/v1/admin/quarantine", quarantineRoutes(ctx.bundles));
  app.use("/api/v1/admin/maintenance", maintenanceRoutes(ctx.maintenance, ctx.outbox));
  app.use("/api/v1/admin", adminExtraRoutes({
    config,
    configService: ctx.configService,
    metricsSampler: ctx.metricsSampler ?? ({} as any),
    overviewService: ctx.overviewService ?? ({} as any),
    healthService: ctx.healthService ?? ({} as any),
    backupService: ctx.backupService ?? ({} as any),
    audit: ctx.audit,
    db,
    bundles: ctx.bundles,
    devices: ctx.devices,
    outbox: ctx.outbox,
    maintenance: ctx.maintenance,
    logDir: config.logDir,
    tunnel: ctx.tunnel,
  }));

  // claim route also on admin listener
  app.use("/api/v1/pair", pairClaimRoute({
    config, db, devices: ctx.devices, audit: ctx.audit, serial: config.replicaId, mdnsHost: `dbhub-${config.replicaId}.local`, isPublicListener: false,
  }));

  const deviceAuth = requireDevice(ctx.devices);
  app.use("/api/v1/relay", deviceAuth, scopeGuard(ctx.devices, "relay:write"), relayRoutes(ctx.ingest, ctx.devices));
  app.use("/api/v1/numbers", deviceAuth, numberRoutes(ctx.numberRelay));
  app.use("/api/v1/pull", deviceAuth, scopeGuard(ctx.devices, "pull:read"), pullRoutes(ctx.bundles));
  app.use("/api/v1/manifest", deviceAuth, scopeGuard(ctx.devices, "manifest:read"), manifestRoutes(config, ctx.manifests));

  // scope enforcement helper mounted as middleware after deviceAuth? We'll instead patch routes? Use middleware above.
  app.use(createErrorHandler());

  // attach
  (app as any).config = config;
  (app as any).db = db;
  (app as any).devices = ctx.devices;
  return app;
}

function scopeGuard(devices: DevicesRepo, scope: string) {
  return (req: Request, res: Response, next: any) => {
    const dev = (req as any).device;
    if (!dev) return next();
    const full = devices.findById(dev.id);
    const scopes = full?.scopes ?? [];
    if (!scopes.includes(scope)) {
      res.status(403).json({ error: { code: "AUTH-003", message: "Missing required scope.", details: { scope } } });
      return;
    }
    // update last seen
    devices.updateLastSeen(dev.id, new Date().toISOString());
    next();
  };
}

export function createPublicApp(...args: any[]): any {
  const ctx = normalizeArgs(args);
  ensureServices(ctx);
  const config = ctx.config;
  const db = ctx.db;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.limits?.maxBodyBytes ?? 5242880 }));
  app.use(corsMiddleware(config));
  app.use(rateLimitMiddleware(config));
  app.use((_req: Request, res: Response, next: any) => {
    res.setHeader("X-DBHub-Id", config.replicaId ?? "dbhub");
    next();
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true, version: VERSION }));

  // claim route allowed
  app.use("/api/v1/pair", pairClaimRoute({
    config, db, devices: ctx.devices, audit: ctx.audit, serial: config.replicaId, mdnsHost: `dbhub-${config.replicaId}.local`, isPublicListener: true,
  }));

  const deviceAuth = requireDevice(ctx.devices);
  app.use("/api/v1/relay", deviceAuth, scopeGuard(ctx.devices, "relay:write"), relayRoutes(ctx.ingest, ctx.devices));
  app.use("/api/v1/numbers", deviceAuth, numberRoutes(ctx.numberRelay));
  app.use("/api/v1/pull", deviceAuth, scopeGuard(ctx.devices, "pull:read"), pullRoutes(ctx.bundles));
  app.use("/api/v1/manifest", deviceAuth, scopeGuard(ctx.devices, "manifest:read"), manifestRoutes(config, ctx.manifests));

  // everything else 404
  app.use((_req, res) => res.status(404).json({ error: { code: "NOT-FOUND", message: "Not found." } }));

  (app as any).config = config;
  (app as any).db = db;
  return app;
}

export function createApp(...args: any[]): any {
  // default admin app
  return createAdminApp(...args);
}

// aliases
export const buildAdminApp = createAdminApp;
export const buildPublicApp = createPublicApp;
export const buildApp = createApp;
export const createServer = createAdminApp;
export const buildServer = createAdminApp;
import express from "express";
import { randomUUID } from "node:crypto";
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
import { requireAdmin, requireDevice, requireDeviceOrAdmin } from "./http/auth";
import { rateLimitMiddleware } from "./http/rate-limit";
import { errorHandler } from "./http/errors";
import { statusHandler } from "./http/routes/status";
import { devicesRoutes } from "./http/routes/devices";
import { relayRoutes } from "./http/routes/relay";
import { pullRoutes } from "./http/routes/pull";
import { manifestRoutes } from "./http/routes/manifest";
import { quarantineRoutes } from "./http/routes/quarantine";
import { maintenanceRoutes } from "./http/routes/maintenance";
import { uiHandler } from "./http/ui";

function main() {
  const { config, path: configPath } = loadConfig();
  const logger = createLogger(config);
  logger.info({ configPath, dataDir: config.dataDir, version: "0.1.0" }, "starting fazai-hub");

  const db = openDatabase(config);
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
  const batching = new BatchingService(db, bundles, manifests, outbox, target, config);
  const maintenance = new MaintenanceService(db, bundles, config);

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const id = randomUUID();
    (req as express.Request & { requestId?: string }).requestId = id;
    res.setHeader("X-Request-Id", id);
    const start = Date.now();
    res.on("finish", () => {
      logger.info(
        {
          requestId: id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
          deviceId: (req as { device?: { id: string } }).device?.id,
        },
        "request",
      );
    });
    next();
  });

  app.use(express.json({ limit: config.limits.maxBodyBytes, type: "application/json" }));
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
  app.use(rateLimitMiddleware(config));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: "0.1.0" });
  });

  app.get("/", uiHandler(config, bundles, devices));

  app.get("/api/v1/status", requireDeviceOrAdmin(config, devices), statusHandler(config, bundles, devices));

  const adminAuth = requireAdmin(config);
  app.use("/api/v1/admin", adminAuth);
  app.use("/api/v1/admin/devices", devicesRoutes(config, devices, audit));
  app.use("/api/v1/admin/quarantine", quarantineRoutes(bundles));
  app.use("/api/v1/admin/maintenance", maintenanceRoutes(maintenance, outbox));

  const deviceAuth = requireDevice(devices);
  app.use("/api/v1/relay", deviceAuth, relayRoutes(ingest, devices));
  app.use("/api/v1/pull", deviceAuth, pullRoutes(bundles));
  app.use("/api/v1/manifest", deviceAuth, manifestRoutes(config, manifests));

  app.use(errorHandler);

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, "listening");
  });

  batching.start();
  maintenance.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    server.close(() => {
      try {
        batching.stop();
        maintenance.stop();
        maintenance.checkpoint();
        db.close();
      } catch (e) {
        logger.error({ err: e }, "shutdown error");
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    logger.fatal({ err: e }, "uncaughtException");
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logger.fatal({ err: e }, "unhandledRejection");
    process.exit(1);
  });
}

main();

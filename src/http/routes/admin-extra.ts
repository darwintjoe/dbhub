import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { Config } from "../../config";
import { VERSION } from "../../domain/types";
import { resolveEndpoints } from "../../services/endpoints";
import type { ConfigService } from "../../services/config-service";
import type { MetricsSampler } from "../../services/metrics/sampler";
import type { OverviewService } from "../../services/overview";
import type { HealthService } from "../../services/health";
import type { BackupService } from "../../services/backup";
import { readLogs, listLogFiles } from "../../services/logs";
import { ApiError } from "../errors";
import { asyncHandler } from "../async-handler";

export interface AdminExtraDeps {
  config: Config;
  configService: ConfigService;
  metricsSampler: MetricsSampler;
  overviewService: OverviewService;
  healthService: HealthService;
  backupService: BackupService;
  audit: any;
  db: any;
  bundles: any;
  devices: any;
  outbox: any;
  maintenance: any;
  logDir: string;
  tunnel?: any;
}

export function adminExtraRoutes(deps: AdminExtraDeps) {
  const router = Router();
  const clients = new Set<any>();

  router.get("/overview", asyncHandler(async (_req: Request, res: Response) => {
    const data = await deps.overviewService.getOverview();
    res.json(data);
  }));

  router.get("/health", asyncHandler(async (_req: Request, res: Response) => {
    const data = await deps.healthService.check();
    res.json(data);
  }));

  router.get("/stream", async (req: Request, res: Response) => {
    if (clients.size >= 20) {
      // close oldest
      const oldest = clients.values().next().value;
      if (oldest) {
        try { oldest.res.end(); } catch { /* ignore */ }
        clients.delete(oldest);
      }
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    // no manual transfer-encoding
    res.flushHeaders?.();
    const client = { res, hb: null as any, unsub: null as any };
    clients.add(client);
    res.write("retry: 5000\n\n");

    const send = (event: string, data: unknown) => {
      if (res.writableLength > 1_000_000) return; // drop
      res.write(`event:${event}\ndata:${JSON.stringify(data)}\n\n`);
    };

    try {
      const snapshot = await deps.metricsSampler.sample();
      const history = deps.metricsSampler.getHistory();
      send("init", { snapshot, history });
    } catch {
      // ignore
    }

    client.unsub = deps.metricsSampler.subscribe((snap) => {
      send("sample", snap);
    });
    client.hb = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* ignore */ }
    }, 15000);

    const cleanup = () => {
      if (client.unsub) client.unsub();
      if (client.hb) clearInterval(client.hb);
      clients.delete(client);
      try { res.end(); } catch { /* ignore */ }
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  router.get("/config", (_req: Request, res: Response) => {
    const redacted = deps.configService.getRedactedConfig();
    res.json({ config: redacted, path: deps.configService.getPath(), hash: deps.configService.getHash() });
  });

  const putSchema = z.object({
    config: z.unknown(),
    baseHash: z.string().optional(),
    force: z.boolean().optional(),
  });
  router.put("/config", asyncHandler(async (req: Request, res: Response) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "CONFIG-001", "Invalid request body.", { details: parsed.error.flatten() });
    const result = await deps.configService.save(parsed.data as any);
    res.json(result);
  }));

  router.post("/config/validate", asyncHandler(async (req: Request, res: Response) => {
    const body = req.body?.config ?? req.body;
    const result = await deps.configService.validate(body);
    res.json(result);
  }));

  router.post("/config/rotate-token", asyncHandler(async (req: Request, res: Response) => {
    const ip = req.ip;
    const ua = req.get("user-agent") ?? undefined;
    const { token } = await deps.configService.rotateAdminToken("admin", ip, ua);
    res.json({ token });
  }));

  // logs
  router.get("/logs", (req: Request, res: Response) => {
    const file = typeof req.query.file === "string" ? req.query.file : undefined;
    const lines = req.query.lines ? Number(req.query.lines) : 200;
    const level = typeof req.query.level === "string" ? req.query.level : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    try {
      const result = readLogs({ dir: deps.logDir, file: file as any, lines, level: level as any, q: q as any });
      res.json(result);
    } catch {
      throw new ApiError(400, "LOG-001", "Invalid log file.");
    }
  });

  router.get("/logs/download", (req: Request, res: Response) => {
    const file = typeof req.query.file === "string" ? req.query.file : "";
    if (!/^hub-\d{4}-\d{2}-\d{2}\.log$/.test(file)) throw new ApiError(400, "LOG-001", "Invalid log file.");
    const fp = path.join(deps.logDir, path.basename(file));
    if (!fp.startsWith(path.resolve(deps.logDir)) || !fs.existsSync(fp)) throw new ApiError(400, "LOG-001", "Invalid log file.");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(file)}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    fs.createReadStream(fp).pipe(res);
  });

  // audit
  router.get("/audit", (req: Request, res: Response) => {
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const items = deps.audit.list(limit, offset);
    const total = deps.audit.count();
    res.json({ items, total, limit, offset });
  });

  // backups
  router.get("/backups", (_req: Request, res: Response) => {
    res.json({ items: deps.backupService.list() });
  });

  router.post("/backups", asyncHandler(async (_req: Request, res: Response) => {
    try {
      const result = await deps.backupService.create();
      if (deps.audit) deps.audit.log(new Date().toISOString(), "admin", "backup.created", { name: result.name });
      res.status(201).json(result);
    } catch {
      throw new ApiError(409, "BACKUP-001", "Backup already running or failed.");
    }
  }));

  router.get("/backups/:name/download", (req: Request, res: Response) => {
    const name = String(req.params.name);
    let fp: string;
    try {
      fp = deps.backupService.resolve(name);
    } catch {
      throw new ApiError(400, "BACKUP-001", "Invalid backup name.");
    }
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(fp)}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    fs.createReadStream(fp).pipe(res);
  });

  // diagnostics
  router.get("/diagnostics", asyncHandler(async (_req: Request, res: Response) => {
    const ifaces = os.networkInterfaces();
    const ips: string[] = [];
    const macs: string[] = [];
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] ?? []) {
        if (info.family === "IPv4" && !info.internal) ips.push(info.address);
        if (info.mac && info.mac !== "00:00:00:00:00:00") macs.push(info.mac);
      }
    }
    res.json({
      hostname: os.hostname(),
      lanIps: [...new Set(ips)],
      macAddresses: [...new Set(macs)],
      mdns: deps.config.connectivity?.mdns ?? { enabled: true },
      adminPort: deps.config.port,
      publicListener: {
        mode: deps.config.connectivity?.mode ?? "lan",
        port: deps.config.connectivity?.publicPort ?? 8788,
      },
      tunnel: deps.tunnel?.getStatus?.() ?? null,
      version: VERSION,
      serial: deps.config.replicaId,
      recentErrors: [],
    });
  }));

  router.get("/bootstrap", asyncHandler(async (_req: Request, res: Response) => {
    const setupRequired = !deps.db.prepare("SELECT 1 FROM admin_credentials WHERE id=1").get();
    const serial = deps.config.replicaId;
    const endpoints = resolveEndpoints(deps.config, serial, `dbhub-${serial}.local`);
    const deviceCount = typeof deps.devices?.count === "function" ? deps.devices.count(deps.config.companyId) : 0;
    res.json({
      setupRequired,
      hub: { id: serial, companyId: deps.config.companyId, version: VERSION },
      endpoints,
      tunnel: deps.tunnel?.getStatus?.() ?? null,
      health: { ok: true },
      counts: { devices: deviceCount, bundles: deps.bundles?.countAll?.() ?? 0 },
      version: VERSION,
      serial,
    });
  }));

  return router;
}

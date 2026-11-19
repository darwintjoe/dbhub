import type { Config } from "../config";
import fs from "node:fs";
import type { OutboxRepo } from "../db/outbox.repo";
import type { BundlesRepo } from "../db/bundles.repo";

export interface HealthDeps {
  config: Config;
  db: any;
  bundles: BundlesRepo;
  outbox: OutboxRepo;
  serverListening?: () => boolean;
  serviceStatsProvider?: () => { batchingLastErrorAt?: string | null; lastChainVerify?: unknown };
  onHealthStatus?: (status: string) => void;
}

export interface HealthReason {
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
}

export class HealthService {
  private readonly deps: HealthDeps;

  constructor(deps: HealthDeps) {
    this.deps = deps;
  }

  check(): { status: string; reasons: HealthReason[]; checks: Record<string, boolean>; sampledAt: string } {
    const { config, db, bundles, outbox } = this.deps;
    const reasons: HealthReason[] = [];
    const checks: Record<string, boolean> = {};

    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
      checks.db = true;
    } catch {
      dbOk = false;
      checks.db = false;
      reasons.push({ severity: "critical", code: "HEALTH-DB", message: "Database probe failed." });
    }

    let dirsOk = true;
    for (const dir of [config.dataDir, config.logDir]) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        checks[`dir:${dir}`] = true;
      } catch {
        dirsOk = false;
        checks[`dir:${dir}`] = false;
        reasons.push({ severity: "critical", code: "HEALTH-DIR", message: `Directory not writable: ${dir}` });
      }
    }

    const listening = this.deps.serverListening ? this.deps.serverListening() : true;
    checks.listener = listening;
    if (!listening) reasons.push({ severity: "critical", code: "HEALTH-LISTENER", message: "Listener closed." });

    const counts = outbox.counts();
    if (counts.failed > 0) {
      reasons.push({ severity: "warning", code: "HEALTH-OUTBOX-FAILED", message: `Failed outbox rows: ${counts.failed}` });
    }

    // oldest pending outbox age
    try {
      const row = db.prepare("SELECT MIN(created_at) AS m FROM outbox WHERE status IN ('pending','uploading')").get() as { m: string | null };
      if (row?.m && Date.now() - Date.parse(row.m) > 10 * 60 * 1000) {
        reasons.push({ severity: "warning", code: "HEALTH-PENDING", message: "Oldest pending outbox older than 10 minutes." });
      }
    } catch {
      // ignore
    }

    const timeout = config.quarantine.pendingParentTimeoutMs;
    const pendingRows = db.prepare("SELECT pending_since FROM bundles WHERE status='pending_parent'").all() as { pending_since: string | null }[];
    const nowMs = Date.now();
    for (const r of pendingRows) {
      if (r.pending_since && nowMs - Date.parse(r.pending_since) > timeout * 0.5) {
        reasons.push({ severity: "warning", code: "HEALTH-PENDING-PARENT", message: "Pending parent older than 50% of timeout." });
        break;
      }
    }

    try {
      const st = fs.statfsSync(config.dataDir);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const pct = total > 0 ? free / total : 1;
      if (pct < 0.1 || free < 1024 * 1024 * 1024) {
        reasons.push({ severity: "warning", code: "HEALTH-DISK", message: "Low disk space." });
      }
    } catch {
      // ignore
    }

    const stats = this.deps.serviceStatsProvider ? this.deps.serviceStatsProvider() : {};
    if (stats.batchingLastErrorAt && Date.now() - Date.parse(stats.batchingLastErrorAt) < 5 * 60 * 1000) {
      reasons.push({ severity: "warning", code: "HEALTH-BATCHING", message: "Batching error within 5 minutes." });
    }

    if (stats.lastChainVerify == null) {
      reasons.push({ severity: "info", code: "HEALTH-CHAIN-UNKNOWN", message: "Chain verification has not been run." });
    }

    let status = "ok";
    if (reasons.some((r) => r.severity === "critical")) status = "down";
    else if (reasons.some((r) => r.severity === "warning")) status = "degraded";

    this.deps.onHealthStatus?.(status);
    return { status, reasons, checks, sampledAt: new Date().toISOString() };
  }
}

import fs from "node:fs";
import type { Config } from "../config";
import type { BundlesRepo } from "../db/bundles.repo";
import type { DevicesRepo } from "../db/devices.repo";
import type { OutboxRepo } from "../db/outbox.repo";
import type { MetricsSampler, HistoryMeta } from "./metrics/sampler";
import type { ConfigService } from "./config-service";
import type { HealthService } from "./health";
import type { BackupService } from "./backup";
import type { CloudflareTunnelProvider } from "./cloudflare-tunnel";
import type { MaintenanceService } from "./maintenance";

export interface OverviewDeps {
  config: Config;
  configService?: ConfigService;
  healthService?: HealthService;
  bundles: BundlesRepo;
  devices: DevicesRepo;
  outbox: OutboxRepo;
  metricsSampler: MetricsSampler;
  backupService?: BackupService;
  tunnel?: CloudflareTunnelProvider;
  maintenance?: MaintenanceService;
  db?: any;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class OverviewService {
  private readonly deps: OverviewDeps;

  constructor(deps: OverviewDeps) {
    this.deps = deps;
  }

  async getOverview() {
    const {
      config, configService, healthService, bundles, devices, outbox,
      metricsSampler, backupService, tunnel, maintenance,
    } = this.deps;
    const snapshot = await metricsSampler.sample();
    const latest = bundles.acceptedHead();
    const insertionHead = bundles.lastAcceptedHead();
    const deviceRows = devices.list(config.companyId);
    const onlineCutoff = Date.now() - 5 * 60 * 1000;
    const recentCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recentByDevice = typeof (bundles as any).countRecentByDevice === "function"
      ? (bundles as any).countRecentByDevice(recentCutoff) as Record<string, number>
      : {};
    const recentEventsByDevice = typeof (bundles as any).countRecentEventsByDevice === "function"
      ? (bundles as any).countRecentEventsByDevice(recentCutoff) as Record<string, number>
      : {};

    let devicesOnline = 0;
    const devicesOut = deviceRows.map((d) => {
      const online = Boolean(d.lastSeenAt && Date.parse(d.lastSeenAt) >= onlineCutoff);
      if (online) devicesOnline++;
      return {
        id: d.id,
        prefix: d.prefix,
        label: d.label,
        status: d.status,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        online,
        accepted: bundles.countByDeviceAndStatus(d.id, "accepted"),
        pending: bundles.countByDeviceAndStatus(d.id, "pending_parent"),
        quarantined: bundles.countByDeviceAndStatus(d.id, "quarantined"),
        recentAccepted: Number(recentByDevice[d.id] ?? 0),
        recentEvents: Number(recentEventsByDevice[d.id] ?? 0),
      };
    });

    const configHash = configService ? configService.getHash() : "";
    const recentBundles = bundles.recent(10).map((b) => ({
      bundleId: b.bundleId,
      deviceId: b.deviceId,
      status: b.status,
      eventCount: b.eventCount,
      receivedAt: b.receivedAt,
      acceptedSeq: b.acceptedSeq,
      hubSeq: b.hubSeq,
    }));

    const verifyResult = maintenance?.lastVerify ?? null;
    const verifiedAt = maintenance?.lastVerifyAt ?? null;
    const verifyStale = verifiedAt ? Date.now() - Date.parse(verifiedAt) > DAY_MS : true;

    const tunnelState = tunnel?.getStatus?.() ?? null;
    const connectivity = {
      mode: config.connectivity?.mode ?? "lan",
      publicUrl: config.connectivity?.publicUrl ?? "",
      tunnel: {
        status: tunnelState?.status ?? "disabled",
        lastError: tunnelState?.lastError ?? null,
        pid: tunnelState?.pid ?? null,
        restartCount: tunnelState?.restartCount ?? 0,
        lastStartAt: tunnelState?.lastStartAt ?? null,
      },
    };

    const storage = this.storageStatus(config);
    // Live mode has no cloud/SAL integration. Describe only what actually exists:
    // the local hub replica and (optionally) a folder replica target.
    const replica = {
      target: storage.target,
      sal: {
        connected: false,
        provider: null,
        health: "Not configured",
        quotaBytes: 0,
        usedBytes: 0,
        lastUploadAt: null,
      },
      replicas: [{
        id: config.replicaId,
        type: "hub",
        role: "hub",
        online: true,
        lastSeenAt: snapshot.sampledAt,
      }],
      manifest: {
        aligned: null,
        localOnly: true,
        latestAcceptedSeq: latest ? (latest.acceptedSeq ?? 0) : 0,
      },
      numberRelay: { active: false, detail: "Not implemented" },
      monitored: 1,
      total: 4,
    };
    const chainRecent = recentBundles.map((b) => ({
      acceptedSeq: b.acceptedSeq,
      status: b.status === "accepted" ? "ok" : "warning",
    }));
    const backup = this.backupStatus(backupService);
    const outboxCounts = outbox.counts();
    const outboxExtras = {
      oldestPendingAgeMs: typeof (outbox as any).oldestPendingAgeMs === "function"
        ? (outbox as any).oldestPendingAgeMs() : null,
      lastSuccessAt: typeof (outbox as any).lastSuccessAt === "function"
        ? (outbox as any).lastSuccessAt() : null,
      lastErrors: typeof (outbox as any).lastErrors === "function"
        ? (outbox as any).lastErrors(5) : [],
    };

    return {
      sampledAt: snapshot.sampledAt,
      health: healthService ? healthService.check() : { status: "ok", reasons: [], checks: {}, sampledAt: new Date().toISOString() },
      process: snapshot.process,
      host: snapshot.host,
      hardware: snapshot.hardware,
      disks: snapshot.disks,
      network: snapshot.network,
      db: snapshot.db,
      service: snapshot.service,
      counts: {
        devices: bundles.countDevices(),
        accepted: bundles.countByStatus("accepted"),
        pendingParent: bundles.countByStatus("pending_parent"),
        quarantined: bundles.countByStatus("quarantined"),
        events: bundles.countEvents(),
      },
      rates: snapshot.rates,
      chain: {
        latestAcceptedSeq: latest ? (latest.acceptedSeq ?? 0) : 0,
        latestHubSeq: insertionHead ? insertionHead.hubSeq : 0,
        latestChainHash: latest ? latest.chainHash : null,
        verify: {
          ok: verifyResult ? verifyResult.ok : null,
          checked: verifyResult ? verifyResult.checked : 0,
          firstBadAcceptedSeq: verifyResult?.firstBadAcceptedSeq ?? null,
          firstBadHubSeq: verifyResult?.firstBadHubSeq ?? null,
          verifiedAt,
          stale: verifyStale,
        },
        // Non-sensitive strip items only: accepted sequence + coarse status.
        recent: chainRecent,
      },
      outbox: { ...outboxCounts, ...outboxExtras },
      devices: devicesOut,
      devicesOnline,
      connectivity,
      storage,
      replica,
      backup,
      recentBundles,
      history: metricsSampler.getHistory(),
      historyMeta: snapshot.historyMeta ?? ({ intervalMs: 5000, points: 0, capacity: 0 } as HistoryMeta),
      config: {
        path: configService ? configService.getPath() : "",
        hash: configHash,
        restartRequired: [],
        stale: configService ? configService.getHash() !== configService.getInitialHash() : false,
        publicUrl: config.publicUrl ?? "",
      },
      version: (await import("../domain/types")).VERSION,
    };
  }

  private storageStatus(config: Config) {
    const target = config.storage?.target ?? "null";
    const folderPath = config.storage?.folderPath ?? "";
    let freeBytes = 0;
    let totalBytes = 0;
    let ready = false;
    let writable = false;
    try {
      const st = fs.statfsSync(config.dataDir);
      totalBytes = st.blocks * st.bsize;
      freeBytes = st.bavail * st.bsize;
      fs.accessSync(config.dataDir, fs.constants.W_OK);
      writable = true;
      ready = true;
    } catch {
      ready = false;
      writable = false;
    }
    if (target === "folder" && folderPath) {
      try {
        fs.accessSync(folderPath, fs.constants.W_OK);
        writable = true;
        ready = true;
      } catch {
        ready = false;
        writable = false;
      }
    }
    return { target, folderPath, ready, writable, freeBytes, totalBytes };
  }

  private backupStatus(backupService?: BackupService) {
    if (!backupService || typeof backupService.list !== "function") {
      return { lastAt: null, lastSize: 0, count: 0, running: false };
    }
    const items = backupService.list();
    const first = items[0];
    return {
      lastAt: first ? new Date(first.mtimeMs).toISOString() : null,
      lastSize: first ? first.size : 0,
      count: items.length,
      running: Boolean((backupService as any).running),
    };
  }
}

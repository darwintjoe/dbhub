import { RingBuffer } from "./types";
import type { HostSample, HardwareInventory } from "./host-generic";
import type { Config } from "../../config";

export interface DbStats {
  hubBytes?: number;
  walBytes?: number;
  shmBytes?: number;
  pageCount?: number;
  pageSize?: number;
  freelistCount?: number;
  journalMode?: string;
  userVersion?: number;
  counts?: {
    accepted?: number;
    pendingParent?: number;
    quarantined?: number;
    quarantinedByReason?: Record<string, number>;
    events?: number;
    bundles?: number;
  };
  outboxOldestPendingAgeMs?: number | null;
  oldestPendingParentAgeMs?: number | null;
  lastAcceptedReceivedAt?: string | null;
}

export interface ServiceStats {
  health?: string;
  listening?: boolean;
  lastIngestAt?: string | null;
  batchingLastRunAt?: string | null;
  batchingLastErrorAt?: string | null;
  maintenanceLastSweepAt?: string | null;
  lastChainVerify?: unknown;
  lastChainVerifyAt?: string | null;
  lastCheckpointAt?: string | null;
  lastBackupAt?: string | null;
  processStartedAt?: string | null;
  windowsServiceState?: string;
  ingestCount?: number;
  activeConnections?: number;
}

export interface OutboxStats {
  counts?: { pending?: number; failed?: number; done?: number; uploading?: number };
  oldestPendingAgeMs?: number | null;
  lastSuccessAt?: string | null;
}

export interface HistoryMeta {
  intervalMs: number;
  points: number;
  capacity: number;
}

/** History payload: numeric series plus a matching array of short time labels. */
export type MetricsHistory = { timeLabels: string[] } & Record<string, number[] | string[]>;

export interface MetricsSnapshot {
  sampledAt: string;
  process: {
    pid: number;
    uptimeSec: number;
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    cpuPercent: number;
    eventLoopLagMs: number;
    activeHandles: number;
    activeRequests: number;
    activeConnections: number;
  };
  host: HostSample;
  hardware: HardwareInventory;
  disks: HostSample["disks"];
  network: HostSample["network"];
  db: DbStats;
  service: ServiceStats;
  counts: NonNullable<DbStats["counts"]>;
  rates: { rxBytesPerSec: number; txBytesPerSec: number };
  requests: any;
  history: MetricsHistory;
  diskUsedByMount: Record<string, number[]>;
  nicRxByName: Record<string, number[]>;
  nicTxByName: Record<string, number[]>;
  historyMeta: HistoryMeta;
}

export interface MetricsSamplerDeps {
  config: Config;
  hostAdapter: { available: boolean; reason?: string; sample(): Promise<HostSample>; hardware(): Promise<HardwareInventory> };
  dbStatsProvider?: () => DbStats;
  serviceStatsProvider?: () => ServiceStats | Promise<ServiceStats>;
  outboxProvider?: () => OutboxStats;
  devicesProvider?: () => { online: number; total: number };
  requestMetrics?: any;
  activeConnectionsProvider?: () => number;
}

type FloatRing = RingBuffer<number>;

export class MetricsSampler {
  private readonly config: Config;
  private readonly hostAdapter: MetricsSamplerDeps["hostAdapter"];
  private readonly dbStatsProvider: () => DbStats;
  private readonly serviceStatsProvider: () => ServiceStats | Promise<ServiceStats>;
  private readonly outboxProvider: () => OutboxStats;
  private readonly devicesProvider: () => { online: number; total: number };
  private readonly requestMetrics: any;
  private readonly activeConnectionsProvider: () => number;

  private cachedSnapshot: MetricsSnapshot | null = null;
  private cachedAt = 0;
  private inFlight: Promise<MetricsSnapshot> | null = null;

  // Legacy keys (kept for compatibility). Requests/ingest now store per-second deltas.
  private cpuHistory: FloatRing;
  private memoryHistory: FloatRing;
  private networkRxHistory: FloatRing;
  private networkTxHistory: FloatRing;
  private diskHistory: FloatRing;
  private requestsHistory: FloatRing;
  private ingestHistory: FloatRing;

  // New detailed histories.
  private hostCpuHistory: FloatRing;
  private hostMemHistory: FloatRing;
  private processHeapHistory: FloatRing;
  private eventLoopLagHistory: FloatRing;
  private dbBytesHistory: FloatRing;
  private acceptedPerSecHistory: FloatRing;
  private eventsPerSecHistory: FloatRing;
  private requestsPerSecHistory: FloatRing;
  private outboxPendingHistory: FloatRing;
  private outboxFailedHistory: FloatRing;
  private outboxDoneHistory: FloatRing;
  private pendingParentHistory: FloatRing;
  private quarantinedHistory: FloatRing;
  private devicesOnlineHistory: FloatRing;
  private chainAcceptedSeqHistory: FloatRing;
  private diskUsedByMount: Record<string, FloatRing> = {};
  private nicRxByName: Record<string, FloatRing> = {};
  private nicTxByName: Record<string, FloatRing> = {};

  private prevCpuUsage = process.cpuUsage();
  private prevCpuTime = Date.now();
  private prevSampleTime = Date.now();
  private prevRequestTotal = 0;
  private prevIngestCount: number | null = null;
  private prevAccepted: number | null = null;
  private prevEvents: number | null = null;
  private eventLoopLag = 0;
  private monitor: any = null;

  private timer: NodeJS.Timeout | null = null;
  private currentInterval = 0;
  private subscribers = new Set<(s: MetricsSnapshot) => void>();

  constructor(deps: MetricsSamplerDeps) {
    this.config = deps.config;
    this.hostAdapter = deps.hostAdapter;
    this.dbStatsProvider = deps.dbStatsProvider ?? (() => ({}));
    this.serviceStatsProvider = deps.serviceStatsProvider ?? (() => ({}));
    this.outboxProvider = deps.outboxProvider ?? (() => ({}));
    this.devicesProvider = deps.devicesProvider ?? (() => ({ online: 0, total: 0 }));
    this.requestMetrics = deps.requestMetrics ?? {};
    this.activeConnectionsProvider = deps.activeConnectionsProvider ?? (() => 0);
    const hp = this.historyPoints();
    this.cpuHistory = new RingBuffer(hp);
    this.memoryHistory = new RingBuffer(hp);
    this.networkRxHistory = new RingBuffer(hp);
    this.networkTxHistory = new RingBuffer(hp);
    this.diskHistory = new RingBuffer(hp);
    this.requestsHistory = new RingBuffer(hp);
    this.ingestHistory = new RingBuffer(hp);
    this.hostCpuHistory = new RingBuffer(hp);
    this.hostMemHistory = new RingBuffer(hp);
    this.processHeapHistory = new RingBuffer(hp);
    this.eventLoopLagHistory = new RingBuffer(hp);
    this.dbBytesHistory = new RingBuffer(hp);
    this.acceptedPerSecHistory = new RingBuffer(hp);
    this.eventsPerSecHistory = new RingBuffer(hp);
    this.requestsPerSecHistory = new RingBuffer(hp);
    this.outboxPendingHistory = new RingBuffer(hp);
    this.outboxFailedHistory = new RingBuffer(hp);
    this.outboxDoneHistory = new RingBuffer(hp);
    this.pendingParentHistory = new RingBuffer(hp);
    this.quarantinedHistory = new RingBuffer(hp);
    this.devicesOnlineHistory = new RingBuffer(hp);
    this.chainAcceptedSeqHistory = new RingBuffer(hp);
    this.startEventLoopMonitor();
    this.ensureLoop();
  }

  private historyPoints(): number {
    const hp = Number((this.config as any)?.monitoring?.historyPoints ?? 120);
    return Math.min(720, Math.max(30, Number.isFinite(hp) ? hp : 120));
  }

  private sampleInterval(): number {
    const v = Number((this.config as any)?.monitoring?.sampleIntervalMs ?? 5000);
    return Math.min(60000, Math.max(1000, Number.isFinite(v) ? v : 5000));
  }

  private monitoringEnabled(): boolean {
    return (this.config as any)?.monitoring?.enabled !== false;
  }

  private hostCountersEnabled(): boolean {
    return this.monitoringEnabled() && (this.config as any)?.monitoring?.hostCounters !== false;
  }

  private startEventLoopMonitor(): void {
    try {
      const perf = require("node:perf_hooks");
      if (perf.monitorEventLoopDelay) {
        this.monitor = perf.monitorEventLoopDelay({ resolution: 20 });
        this.monitor.enable();
      }
    } catch {
      this.monitor = null;
    }
  }

  private ensureLoop(): void {
    const interval = this.sampleInterval();
    if (this.timer && this.currentInterval === interval) return;
    if (this.timer) clearInterval(this.timer);
    this.currentInterval = interval;
    this.timer = setInterval(() => {
      void this.sample().catch(() => undefined);
    }, interval);
    this.timer.unref();
  }

  subscribe(listener: (s: MetricsSnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async sample(): Promise<MetricsSnapshot> {
    this.ensureLoop();
    const now = Date.now();
    if (this.cachedSnapshot && now - this.cachedAt < 1000) return this.cachedSnapshot;
    if (this.inFlight) return this.inFlight;
    const run = this.doSample().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doSample(): Promise<MetricsSnapshot> {
    const sampledAt = new Date().toISOString();
    const enabled = this.monitoringEnabled();

    const mem = process.memoryUsage();
    const cpuNow = process.cpuUsage();
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.prevCpuTime);
    const cpuDelta = (cpuNow.user + cpuNow.system) - (this.prevCpuUsage.user + this.prevCpuUsage.system);
    const cpuPercent = (cpuDelta / 1000 / elapsedMs) * 100;
    this.prevCpuUsage = cpuNow;
    this.prevCpuTime = now;

    let eventLoopLag = 0;
    if (this.monitor) {
      eventLoopLag = this.monitor.mean / 1e6;
      this.monitor.reset();
    }
    this.eventLoopLag = eventLoopLag;

    let host: HostSample;
    let hardware: HardwareInventory;
    if (enabled && this.hostCountersEnabled()) {
      host = await this.hostAdapter.sample();
      hardware = await this.hostAdapter.hardware();
    } else {
      host = this.cachedSnapshot?.host ?? {
        available: false,
        reason: "sampling disabled",
        hostname: "unknown",
        platform: process.platform,
        release: "",
        arch: process.arch,
        cpuModel: "unknown",
        cpuCores: 0,
        cpuLogical: 0,
        cpuSpeedMhz: 0,
        loadAvg: [],
        cpuPercentTotal: null,
        cpuPercentPerCore: null,
        memoryTotalBytes: 0,
        memoryFreeBytes: 0,
        memoryUsedBytes: 0,
        swapTotalBytes: null,
        swapFreeBytes: null,
        uptimeSec: 0,
        disks: [],
        network: [],
        sampledAt,
      } as any;
      hardware = this.cachedSnapshot?.hardware ?? {
        available: false,
        reason: "sampling disabled",
        cpu: { model: "unknown", cores: 0, logical: 0, speedMhz: 0 },
        memoryModules: [],
        physicalDisks: [],
        logicalVolumes: [],
        nics: [],
        os: { caption: "", version: "" },
        cachedAt: sampledAt,
      } as any;
    }

    const dbStats = enabled ? this.dbStatsProvider() : (this.cachedSnapshot?.db ?? {});
    const serviceStats = enabled ? await Promise.resolve(this.serviceStatsProvider()) : (this.cachedSnapshot?.service ?? {});
    const outboxStats = enabled ? this.outboxProvider() : {};
    const deviceStats = enabled ? this.devicesProvider() : { online: 0, total: 0 };
    const reqMetrics = this.requestMetrics?.snapshot ? this.requestMetrics.snapshot() : (this.requestMetrics ?? {});

    const activeConnections = this.activeConnectionsProvider();
    let activeHandles = 0;
    let activeRequests = 0;
    try {
      const procAny = process as any;
      if (typeof procAny._getActiveHandles === "function") activeHandles = procAny._getActiveHandles().length;
      if (typeof procAny._getActiveRequests === "function") activeRequests = procAny._getActiveRequests().length;
    } catch {
      // ignore
    }

    const rxTotal = (host.network ?? []).reduce((a: number, n: any) => a + (n.rxBytesPerSec ?? 0), 0);
    const txTotal = (host.network ?? []).reduce((a: number, n: any) => a + (n.txBytesPerSec ?? 0), 0);

    const seconds = Math.max(0.001, (now - this.prevSampleTime) / 1000);
    this.prevSampleTime = now;
    const requestTotal = Number(reqMetrics?.total ?? 0);
    const ingestCount = Number(serviceStats?.ingestCount ?? 0);
    const acceptedTotal = Number(dbStats?.counts?.accepted ?? 0);
    const eventsTotal = Number(dbStats?.counts?.events ?? 0);
    const requestRate = Math.max(0, requestTotal - this.prevRequestTotal) / seconds;
    const ingestRate = this.prevIngestCount === null ? 0 : Math.max(0, ingestCount - this.prevIngestCount) / seconds;
    const acceptedRate = this.prevAccepted === null ? 0 : Math.max(0, acceptedTotal - this.prevAccepted) / seconds;
    const eventsRate = this.prevEvents === null ? 0 : Math.max(0, eventsTotal - this.prevEvents) / seconds;
    this.prevRequestTotal = requestTotal;
    this.prevIngestCount = ingestCount;
    this.prevAccepted = acceptedTotal;
    this.prevEvents = eventsTotal;

    const hostCpu = Number(host.cpuPercentTotal);
    const hostMemPct = Number(host.memoryTotalBytes) > 0
      ? (Number(host.memoryUsedBytes) / Number(host.memoryTotalBytes)) * 100 : 0;

    if (enabled) {
      this.ensureCapacity(this.historyPoints());
      // Legacy keys — rates/deltas instead of cumulative totals.
      this.cpuHistory.push(cpuPercent);
      this.memoryHistory.push(mem.rss);
      this.networkRxHistory.push(rxTotal);
      this.networkTxHistory.push(txTotal);
      this.diskHistory.push(host.disks?.[0]?.usedPercent ?? 0);
      this.requestsHistory.push(requestRate);
      this.ingestHistory.push(ingestRate);
      // Detailed keys.
      this.hostCpuHistory.push(Number.isFinite(hostCpu) ? hostCpu : 0);
      this.hostMemHistory.push(Number.isFinite(hostMemPct) ? hostMemPct : 0);
      this.processHeapHistory.push(mem.heapUsed);
      this.eventLoopLagHistory.push(eventLoopLag);
      this.dbBytesHistory.push(Number(dbStats?.hubBytes ?? 0));
      this.acceptedPerSecHistory.push(acceptedRate);
      this.eventsPerSecHistory.push(eventsRate);
      this.requestsPerSecHistory.push(requestRate);
      this.outboxPendingHistory.push(Number(outboxStats?.counts?.pending ?? 0));
      this.outboxFailedHistory.push(Number(outboxStats?.counts?.failed ?? 0));
      this.outboxDoneHistory.push(Number(outboxStats?.counts?.done ?? 0));
      this.pendingParentHistory.push(Number(dbStats?.counts?.pendingParent ?? 0));
      this.quarantinedHistory.push(Number(dbStats?.counts?.quarantined ?? 0));
      this.devicesOnlineHistory.push(Number(deviceStats.online ?? 0));
      this.chainAcceptedSeqHistory.push(acceptedTotal);
      for (const disk of host.disks ?? []) {
        const key = disk.mount || "default";
        if (!this.diskUsedByMount[key]) this.diskUsedByMount[key] = new RingBuffer(this.historyPoints());
        this.diskUsedByMount[key].push(Number(disk.usedPercent ?? 0));
      }
      for (const nic of host.network ?? []) {
        const key = nic.name || "default";
        if (!this.nicRxByName[key]) this.nicRxByName[key] = new RingBuffer(this.historyPoints());
        if (!this.nicTxByName[key]) this.nicTxByName[key] = new RingBuffer(this.historyPoints());
        this.nicRxByName[key].push(Number(nic.rxBytesPerSec ?? 0));
        this.nicTxByName[key].push(Number(nic.txBytesPerSec ?? 0));
      }
      // Resize dynamic series to the configured capacity.
      const hp = this.historyPoints();
      for (const ring of Object.values(this.diskUsedByMount)) ring?.resize(hp);
      for (const ring of Object.values(this.nicRxByName)) ring?.resize(hp);
      for (const ring of Object.values(this.nicTxByName)) ring?.resize(hp);
    }

    const history = this.getHistory();
    const snapshot: MetricsSnapshot = {
      sampledAt,
      process: {
        pid: process.pid,
        uptimeSec: Math.floor(process.uptime()),
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
        arrayBuffersBytes: (mem as any).arrayBuffers ?? 0,
        cpuPercent,
        eventLoopLagMs: eventLoopLag,
        activeHandles,
        activeRequests,
        activeConnections,
      },
      host,
      hardware,
      disks: host.disks ?? [],
      network: host.network ?? [],
      db: dbStats,
      service: { ...serviceStats, activeConnections },
      counts: dbStats?.counts ?? {},
      rates: { rxBytesPerSec: rxTotal, txBytesPerSec: txTotal },
      requests: reqMetrics,
      history,
      diskUsedByMount: this.mapRings(this.diskUsedByMount),
      nicRxByName: this.mapRings(this.nicRxByName),
      nicTxByName: this.mapRings(this.nicTxByName),
      historyMeta: {
        intervalMs: this.sampleInterval(),
        points: this.cpuHistory.toArray().length,
        capacity: this.historyPoints(),
      },
    };
    this.cachedSnapshot = snapshot;
    this.cachedAt = Date.now();
    for (const listener of this.subscribers) {
      try { listener(snapshot); } catch { /* ignore */ }
    }
    return snapshot;
  }

  private mapRings(source: Record<string, FloatRing>): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [key, ring] of Object.entries(source)) out[key] = ring.toArray();
    return out;
  }

  private ensureCapacity(n: number): void {
    const fixed = [
      this.cpuHistory, this.memoryHistory, this.networkRxHistory, this.networkTxHistory,
      this.diskHistory, this.requestsHistory, this.ingestHistory, this.hostCpuHistory,
      this.hostMemHistory, this.processHeapHistory, this.eventLoopLagHistory, this.dbBytesHistory,
      this.acceptedPerSecHistory, this.eventsPerSecHistory, this.requestsPerSecHistory,
      this.outboxPendingHistory, this.outboxFailedHistory, this.outboxDoneHistory,
      this.pendingParentHistory, this.quarantinedHistory, this.devicesOnlineHistory,
      this.chainAcceptedSeqHistory,
    ];
    for (const ring of fixed) ring.resize(n);
  }

  /** Short relative labels (oldest-first) matching the numeric series length. */
  private timeLabels(count: number): string[] {
    if (count <= 0) return [];
    const intervalMs = this.sampleInterval();
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const secondsBack = (count - 1 - i) * intervalMs / 1000;
      labels.push(secondsBack < 1 ? "now" : `-${Math.round(secondsBack)}s`);
    }
    return labels;
  }

  getHistory(): MetricsHistory {
    return {
      timeLabels: this.timeLabels(this.cpuHistory.toArray().length),
      // legacy keys
      cpu: this.cpuHistory.toArray(),
      memory: this.memoryHistory.toArray(),
      networkRx: this.networkRxHistory.toArray(),
      networkTx: this.networkTxHistory.toArray(),
      disk: this.diskHistory.toArray(),
      requests: this.requestsHistory.toArray(),
      ingest: this.ingestHistory.toArray(),
      // detailed keys
      hostCpu: this.hostCpuHistory.toArray(),
      hostMemUsedPercent: this.hostMemHistory.toArray(),
      processHeap: this.processHeapHistory.toArray(),
      eventLoopLag: this.eventLoopLagHistory.toArray(),
      diskRead: [],
      diskWrite: [],
      dbBytes: this.dbBytesHistory.toArray(),
      acceptedPerSec: this.acceptedPerSecHistory.toArray(),
      eventsPerSec: this.eventsPerSecHistory.toArray(),
      requestsPerSec: this.requestsPerSecHistory.toArray(),
      outboxPending: this.outboxPendingHistory.toArray(),
      outboxFailed: this.outboxFailedHistory.toArray(),
      outboxDone: this.outboxDoneHistory.toArray(),
      pendingParent: this.pendingParentHistory.toArray(),
      quarantined: this.quarantinedHistory.toArray(),
      devicesOnline: this.devicesOnlineHistory.toArray(),
      chainAcceptedSeq: this.chainAcceptedSeqHistory.toArray(),
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// Frontend-only demo mode. Zero real network requests when active.
// All values are simulated with a seeded random walk so charts look alive.

const DEMO_KEY = "dbhub_demo";
const SCENARIO_KEY = "dbhub_demo_scenario";
const DEFAULT_SCENARIO = "healthy";

export function isDemo() {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("demo") === "1") return true;
    return sessionStorage.getItem(DEMO_KEY) === "1";
  } catch (e) {
    return false;
  }
}

export function demoScenario() {
  try {
    const s = sessionStorage.getItem(SCENARIO_KEY);
    return s === "warning" || s === "critical" ? s : DEFAULT_SCENARIO;
  } catch (e) {
    return DEFAULT_SCENARIO;
  }
}

export function enableDemo(scenario) {
  try {
    sessionStorage.setItem(DEMO_KEY, "1");
    if (scenario) sessionStorage.setItem(SCENARIO_KEY, scenario);
  } catch (e) { /* ignore */ }
  syncUrl(true);
}

export function disableDemo() {
  try {
    sessionStorage.removeItem(DEMO_KEY);
    sessionStorage.removeItem(SCENARIO_KEY);
  } catch (e) { /* ignore */ }
  syncUrl(false);
}

export function setDemoScenario(scenario) {
  try { sessionStorage.setItem(SCENARIO_KEY, scenario); } catch (e) { /* ignore */ }
}

function syncUrl(on) {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (on) url.searchParams.set("demo", "1");
  else url.searchParams.delete("demo");
  try { window.history.replaceState(null, "", url.toString()); } catch (e) { /* ignore */ }
}

/* ----------------------------- seeded random ------------------------------ */

function seedFrom(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CAPACITY = 120;
const HISTORY_KEYS = [
  "hostCpu", "hostMemUsedPercent", "processHeap", "eventLoopLag", "disk",
  "networkRx", "networkTx", "dbBytes", "acceptedPerSec", "eventsPerSec",
  "requestsPerSec", "outboxPending", "outboxFailed", "outboxDone",
  "pendingParent", "quarantined", "devicesOnline", "chainAcceptedSeq",
];

const SCENARIOS = {
  healthy: {
    cpu: 42, mem: 58, disk: 38, diskTotal: 512e9, rx: 2.4e6, tx: 1.1e6,
    chainOk: true, verifyHoursAgo: 2, backupHoursAgo: 6,
    outbox: { pending: 2, uploading: 1, done: 128, failed: 0 }, pendingMin: 3,
    salConnected: true, quotaUsed: 2.3e9, staleMin: 8, offline: 1,
    tunnel: "connected", manifestAligned: true, relay: true,
    quarantined: 1, acceptedBase: 1284, eventsBase: 6420,
  },
  warning: {
    cpu: 88, mem: 88, disk: 84, diskTotal: 512e9, rx: 8.2e6, tx: 5.4e6,
    chainOk: true, verifyHoursAgo: 30, backupHoursAgo: 30,
    outbox: { pending: 9, uploading: 2, done: 128, failed: 0 }, pendingMin: 16,
    salConnected: true, quotaUsed: 13.8e9, staleMin: 22, offline: 1,
    tunnel: "error", manifestAligned: false, relay: true,
    quarantined: 4, acceptedBase: 1310, eventsBase: 6550,
  },
  critical: {
    cpu: 97, mem: 96, disk: 93, diskTotal: 12e9, rx: 11e6, tx: 9e6,
    chainOk: false, verifyHoursAgo: 52, backupHoursAgo: null,
    outbox: { pending: 30, uploading: 3, done: 128, failed: 4 }, pendingMin: 45,
    salConnected: false, quotaUsed: 14.9e9, staleMin: 130, offline: 2,
    tunnel: "not_installed", manifestAligned: false, relay: false,
    quarantined: 12, acceptedBase: 1342, eventsBase: 6710,
  },
};

let state = null;

function resetState(scenario) {
  const cfg = SCENARIOS[scenario] || SCENARIOS.healthy;
  const rng = mulberry32(seedFrom(`dbhub-${scenario}`));
  const history = {};
  for (const key of HISTORY_KEYS) history[key] = [];
  const s = {
    scenario, cfg, rng, history, tick: 0,
    cpu: cfg.cpu, mem: cfg.mem, disk: cfg.disk, rx: cfg.rx, tx: cfg.tx,
    heap: 46e6, lag: 2.5, dbBytes: 184e6,
    acceptedRate: 1.4, eventsRate: 7.2, requestsRate: 4.1,
    outboxPending: cfg.outbox.pending, outboxFailed: cfg.outbox.failed, outboxDone: cfg.outbox.done,
    pendingParent: 1, quarantined: cfg.quarantined, devicesOnline: 4,
    acceptedSeq: cfg.acceptedBase,
    cores: Array.from({ length: 8 }, () => cfg.cpu),
    startedAt: Date.now(),
  };
  state = s;
  // Pre-seed so charts are populated immediately.
  for (let i = 0; i < CAPACITY; i++) advance();
  return s;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function walk(current, target, volatility, min, max, rng) {
  const drift = (target - current) * 0.08;
  const noise = (rng() - 0.5) * volatility;
  return clamp(current + drift + noise, min, max);
}

function push(key, value) {
  const arr = state.history[key];
  arr.push(Number(value.toFixed ? value.toFixed(2) : value));
  if (arr.length > CAPACITY) arr.shift();
}

function advance() {
  const s = state;
  const c = s.cfg;
  const rng = s.rng;
  s.tick++;
  s.cpu = walk(s.cpu, c.cpu, 11, 3, 100, rng);
  s.mem = walk(s.mem, c.mem, 5, 20, 99, rng);
  s.disk = walk(s.disk, c.disk, 0.8, 1, 100, rng);
  s.rx = walk(s.rx, c.rx, 0.8e6, 0, 40e6, rng);
  s.tx = walk(s.tx, c.tx, 0.5e6, 0, 30e6, rng);
  s.heap = walk(s.heap, 52e6, 1.4e6, 20e6, 120e6, rng);
  s.lag = walk(s.lag, c.cpu > 90 ? 42 : 3, 2, 0.2, 120, rng);
  s.dbBytes = walk(s.dbBytes, 184e6, 0.35e6, 100e6, 400e6, rng);
  s.acceptedRate = walk(s.acceptedRate, c.cpu > 90 ? 5 : 1.4, 0.5, 0, 12, rng);
  s.eventsRate = walk(s.eventsRate, 7.2, 1.4, 0, 24, rng);
  s.requestsRate = walk(s.requestsRate, 4.1, 1.2, 0, 18, rng);
  s.outboxPending = clamp(c.outbox.pending + Math.round((rng() - 0.5) * 2), 0, 60);
  s.outboxFailed = c.outbox.failed;
  s.outboxDone = c.outbox.done + s.tick;
  s.pendingParent = clamp(1 + Math.round((rng() - 0.5) * 1.5), 0, 8);
  s.quarantined = c.quarantined;
  s.devicesOnline = 5 - c.offline;
  s.acceptedSeq = c.acceptedBase + Math.floor(s.tick / 3);
  s.cores = s.cores.map((v, i) => walk(v, c.cpu + (i % 3) * 2 - 2, 14, 2, 100, rng));

  push("hostCpu", s.cpu);
  push("hostMemUsedPercent", s.mem);
  push("processHeap", s.heap);
  push("eventLoopLag", s.lag);
  push("disk", s.disk);
  push("networkRx", s.rx);
  push("networkTx", s.tx);
  push("dbBytes", s.dbBytes);
  push("acceptedPerSec", s.acceptedRate);
  push("eventsPerSec", s.eventsRate);
  push("requestsPerSec", s.requestsRate);
  push("outboxPending", s.outboxPending);
  push("outboxFailed", s.outboxFailed);
  push("outboxDone", s.outboxDone);
  push("pendingParent", s.pendingParent);
  push("quarantined", s.quarantined);
  push("devicesOnline", s.devicesOnline);
  push("chainAcceptedSeq", s.acceptedSeq);
}

function isoAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}
function isoAgoHours(hours) {
  return hours === null ? null : isoAgo(hours * 60);
}

function hash(seed) {
  let out = "";
  const r = mulberry32(seedFrom(seed));
  const chars = "0123456789abcdef";
  for (let i = 0; i < 64; i++) out += chars[Math.floor(r() * 16)];
  return out;
}

function buildDevices(cfg) {
  const names = [
    ["dev_kasir1", "KASIR-1", "KASIR1"],
    ["dev_kasir2", "KASIR-2", "KASIR2"],
    ["dev_gudang", "GUDANG", "GDG"],
    ["dev_bandung", "BANDUNG", "BDG"],
    ["dev_stale", "KASIR-3", "KASIR3"],
  ];
  return names.map(([id, label, prefix], i) => {
    const offlineSlot = i >= 5 - cfg.offline;
    const lastSeenAt = offlineSlot ? isoAgo(cfg.staleMin + i * 7) : isoAgo(0.2 + i * 0.7);
    const online = !offlineSlot;
    return {
      id, label, prefix,
      status: "approved",
      online,
      lastSeenAt,
      appVersion: i === 4 ? "1.4.2" : "2.0.1",
      role: i === 0 ? "Full replica — not implemented" : "Working node",
      accepted: 210 + i * 37,
      pending: i === 4 ? 1 : 0,
      quarantined: i === 3 && cfg.quarantined > 0 ? Math.min(2, cfg.quarantined) : 0,
      recentAccepted: 12 + i * 3,
      recentEvents: 40 + i * 11,
      recentLoad: Array.from({ length: 12 }, (_, j) => clamp(20 + ((i * 13 + j * 7) % 60) + (online ? 0 : -15), 1, 95)),
    };
  });
}

function replicaSet(cfg, scenario) {
  const now = isoAgo(0.1);
  const recent = isoAgo(0.3);
  return [
    { id: "drive", type: "Google Drive", label: "Google Drive", status: cfg.salConnected ? "GOOD" : "CRITICAL", lastSeenAt: cfg.salConnected ? recent : isoAgo(2000), manifestAligned: cfg.manifestAligned, detail: cfg.salConnected ? "Full replica · 2.3 GB of 15 GB" : "Not connected" },
    { id: "hub", type: "Hub", label: "This hub", status: "GOOD", lastSeenAt: now, manifestAligned: true, detail: "Full local replica" },
    { id: "admin", type: "Admin device", label: "Admin device", status: "GOOD", lastSeenAt: isoAgo(4), manifestAligned: true, detail: "Full replica" },
    { id: "supabase", type: "Supabase", label: "Supabase", status: scenario === "critical" ? "WARNING" : "GOOD", lastSeenAt: isoAgo(scenario === "critical" ? 30 : 1.5), manifestAligned: scenario === "healthy", detail: "Emergency backup (partial)" },
  ];
}

function buildSnapshot() {
  const s = state;
  const cfg = s.cfg;
  const now = new Date().toISOString();
  const verifyAt = isoAgoHours(cfg.verifyHoursAgo);
  const backupAt = isoAgoHours(cfg.backupHoursAgo);
  const quotaBytes = 15e9;
  const freeBytes = cfg.diskTotal * (1 - s.disk / 100);
  const usedBytes = cfg.diskTotal - freeBytes;
  const devices = buildDevices(cfg);
  const tunnelLastError = cfg.tunnel === "error" ? "Tunnel handshake failed" : cfg.tunnel === "not_installed" ? "cloudflared binary not found" : null;

  const chainRecent = Array.from({ length: 12 }, (_, i) => ({
    acceptedSeq: s.acceptedSeq - (11 - i),
    status: cfg.chainOk || i > 0 ? "ok" : "critical",
    hash: hash(s.acceptedSeq - (11 - i)),
  }));

  const snapshot = {
    sampledAt: now,
    demo: true,
    scenario: s.scenario,
    health: {
      status: s.scenario === "critical" ? "down" : s.scenario === "warning" ? "degraded" : "ok",
      reasons: [],
      checks: { db: true, listener: true, replica: cfg.salConnected },
      sampledAt: now,
    },
    process: {
      pid: 4242, uptimeSec: Math.floor((Date.now() - s.startedAt) / 1000) + 86400,
      rssBytes: 128e6, heapUsedBytes: s.heap, heapTotalBytes: 180e6,
      cpuPercent: s.cpu * 0.35, eventLoopLagMs: s.lag, activeConnections: 2,
      activeHandles: 18, activeRequests: 0,
    },
    host: {
      available: true, hostname: "demo-hub", platform: "demo", release: "1", arch: "x64",
      cpuModel: "Intel N100 (simulated)", cpuCores: 4, cpuLogical: 8, cpuSpeedMhz: 2400,
      loadAvg: [1.2, 1.1, 0.9], cpuPercentTotal: s.cpu, cpuPercentPerCore: s.cores,
      memoryTotalBytes: 8e9, memoryUsedBytes: 8e9 * (s.mem / 100), memoryFreeBytes: 8e9 * (1 - s.mem / 100),
      swapTotalBytes: 2e9, swapFreeBytes: 1.9e9, uptimeSec: 86400 + s.tick * 5,
      disks: [], network: [], sampledAt: now,
    },
    hardware: {
      available: true,
      cpu: { model: "Intel N100 (simulated)", cores: 4, logical: 8, speedMhz: 2400 },
      memoryModules: [{ capacityBytes: 8e9, speedMhz: 3200, manufacturer: "Simulated" }],
      physicalDisks: [{ model: "Simulated SSD", sizeBytes: cfg.diskTotal, interface: "NVMe" }],
      logicalVolumes: [{ mount: "C:", label: "System", totalBytes: cfg.diskTotal }],
      nics: [{ name: "Ethernet", description: "Simulated gigabit", mac: "00:11:22:33:44:55", speedMbps: 1000 }],
      os: { caption: "Demo OS", version: "1" }, cachedAt: now,
    },
    disks: [
      {
        mount: "C:", label: "System", totalBytes: cfg.diskTotal, freeBytes, usedBytes,
        usedPercent: s.disk, readBytesPerSec: s.rx * 0.4, writeBytesPerSec: s.tx * 0.4,
        busyPercent: clamp(s.disk * 0.7, 0, 100), queueLength: 1,
      },
      {
        mount: "D:", label: "Data", totalBytes: 1024e9, freeBytes: 810e9, usedBytes: 214e9,
        usedPercent: 20.9, readBytesPerSec: 120e3, writeBytesPerSec: 90e3,
        busyPercent: 8, queueLength: 0,
      },
    ],
    network: [
      {
        name: "Ethernet", description: "Simulated gigabit", status: "up", linkSpeedMbps: 1000,
        mac: "00:11:22:33:44:55", ipv4: ["192.168.1.50"],
        rxBytesPerSec: s.rx, txBytesPerSec: s.tx,
        rxErrors: cfg.tunnel === "error" ? 12 : 0, txErrors: 0,
        rxDiscards: 0, txDiscards: 2,
      },
      {
        name: "Wi-Fi", description: "Simulated wireless", status: "up", linkSpeedMbps: 300,
        mac: "00:11:22:33:44:56", ipv4: ["192.168.1.51"],
        rxBytesPerSec: s.rx * 0.12, txBytesPerSec: s.tx * 0.1,
        rxErrors: 0, txErrors: 0, rxDiscards: 1, txDiscards: 0,
      },
    ],
    db: {
      hubBytes: s.dbBytes, walBytes: 2.4e6, shmBytes: 32768,
      pageCount: Math.round(s.dbBytes / 4096), pageSize: 4096,
      freelistCount: 3, journalMode: "wal", userVersion: 3,
      counts: { accepted: s.acceptedSeq, pendingParent: s.pendingParent, quarantined: cfg.quarantined, events: cfg.eventsBase, bundles: s.acceptedSeq + 10 },
    },
    service: {
      health: snapshotHealth(s.scenario), listening: true,
      lastIngestAt: isoAgo(0.2), maintenanceLastSweepAt: isoAgo(1), lastCheckpointAt: isoAgo(3),
      lastBackupAt: backupAt, lastChainVerifyAt: verifyAt, processStartedAt: isoAgoHours(24),
      activeConnections: 2, ingestCount: cfg.eventsBase,
    },
    counts: {
      devices: 5, accepted: s.acceptedSeq, pendingParent: s.pendingParent,
      quarantined: cfg.quarantined, events: cfg.eventsBase, bundles: s.acceptedSeq + 10,
    },
    rates: { rxBytesPerSec: s.rx, txBytesPerSec: s.tx },
    chain: {
      latestAcceptedSeq: s.acceptedSeq,
      latestHubSeq: s.acceptedSeq + 4,
      latestChainHash: hash("head"),
      lastAcceptedReceivedAt: isoAgo(0.2),
      verify: {
        ok: cfg.chainOk,
        checked: cfg.chainOk ? s.acceptedSeq : 940,
        firstBadAcceptedSeq: cfg.chainOk ? null : 941,
        firstBadHubSeq: cfg.chainOk ? null : 945,
        verifiedAt: verifyAt,
        stale: verifyAt ? Date.now() - Date.parse(verifyAt) > 24 * 60 * 60 * 1000 : true,
      },
      recent: chainRecent,
    },
    outbox: {
      counts: { ...cfg.outbox, pending: s.outboxPending, failed: s.outboxFailed, done: s.outboxDone },
      oldestPendingAgeMs: cfg.pendingMin * 60 * 1000,
      lastSuccessAt: cfg.outbox.failed > 0 ? isoAgo(38) : isoAgo(0.3),
      throughputPerSec: 2.4,
      lastErrors: cfg.outbox.failed > 0
        ? [{ bundleId: "bdl_sim_1", target: "google_drive", lastError: "Upload quota exceeded (simulated)" }]
        : [],
    },
    replica: {
      target: cfg.salConnected ? "google_drive" : "folder",
      sal: {
        connected: cfg.salConnected,
        provider: "Google Drive",
        health: cfg.salConnected ? "OK" : "Not configured",
        quotaBytes, usedBytes: cfg.quotaUsed, freeBytes: quotaBytes - cfg.quotaUsed,
        lastUploadAt: cfg.salConnected ? isoAgo(cfg.outbox.failed > 0 ? 38 : 0.3) : null,
        lastError: cfg.outbox.failed > 0 ? "Upload quota exceeded (simulated)" : null,
      },
      replicas: replicaSet(cfg, s.scenario),
      manifest: { aligned: cfg.manifestAligned, latestAcceptedSeq: s.acceptedSeq, localOnly: !cfg.manifestAligned },
      numberRelay: { active: cfg.relay, detail: cfg.relay ? "Active (simulated)" : "Not implemented (simulated)" },
      monitored: cfg.salConnected ? 4 : 1,
      total: 4,
    },
    backup: {
      lastAt: backupAt,
      lastSize: backupAt ? 184e6 : 0,
      count: backupAt ? 14 : 0,
      running: false,
      policy: { warningAfterHours: 24, minFreeBytes: 10e9 },
      items: backupAt ? Array.from({ length: 6 }, (_, i) => ({ name: `hub-2026111${6 - i}-120000.sqlite`, size: 180e6 + i * 1e6, mtimeMs: Date.now() - i * 86400000 })) : [],
    },
    connectivity: {
      mode: cfg.tunnel === "connected" || cfg.tunnel === "error" ? "cloudflare" : "lan",
      publicUrl: cfg.tunnel === "not_installed" ? "" : "https://hub.demo.example.com",
      tunnel: {
        status: cfg.tunnel, lastError: tunnelLastError, pid: cfg.tunnel === "connected" ? 9102 : null,
        restartCount: cfg.tunnel === "error" ? 3 : 1, lastStartAt: isoAgo(6),
      },
      publicListener: { mode: "cloudflare", port: 8788 },
    },
    storage: {
      target: cfg.salConnected ? "google_drive" : "folder",
      folderPath: "C:\\ProgramData\\DBHub\\replica (simulated)",
      ready: true, writable: true, freeBytes, totalBytes: cfg.diskTotal,
    },
    devicesOnline: 5 - cfg.offline,
    devices,
    recentBundles: chainRecent.slice(-8).map((r, i) => ({
      bundleId: `bdl_sim_${r.acceptedSeq}`, deviceId: devices[i % 4].id,
      status: "accepted", eventCount: 3, receivedAt: isoAgo(0.5 + i * 0.4),
      acceptedSeq: r.acceptedSeq, hubSeq: r.acceptedSeq + 4,
    })),
    config: { path: "demo://config.json", hash: "demo", publicUrl: "https://hub.demo.example.com" },
    version: "0.3.0-demo",
    historyMeta: { intervalMs: 5000, points: CAPACITY, capacity: CAPACITY },
    history: currentHistory(),
  };
  return snapshot;
}

function snapshotHealth(scenario) {
  if (scenario === "critical") return "down";
  if (scenario === "warning") return "degraded";
  return "ok";
}

function currentHistory() {
  const points = state.history.hostCpu.length;
  const intervalMs = 5000;
  const timeLabels = [];
  for (let i = 0; i < points; i++) {
    const secondsBack = (points - 1 - i) * intervalMs / 1000;
    timeLabels.push(secondsBack < 1 ? "now" : `-${Math.round(secondsBack)}s`);
  }
  const out = {
    timeLabels,
    cpu: state.history.hostCpu.slice(),
    memory: state.history.processHeap.slice(),
    networkRx: state.history.networkRx.slice(),
    networkTx: state.history.networkTx.slice(),
    disk: state.history.disk.slice(),
    requests: state.history.requestsPerSec.slice(),
    ingest: state.history.acceptedPerSec.slice(),
  };
  for (const key of HISTORY_KEYS) out[key] = state.history[key].slice();
  // Convenience aliases used by views.
  out.hostCpu = out.cpu;
  out.hostMemUsedPercent = state.history.hostMemUsedPercent.slice();
  out.dbBytes = state.history.dbBytes.slice();
  out.acceptedPerSec = state.history.acceptedPerSec.slice();
  out.eventsPerSec = state.history.eventsPerSec.slice();
  return out;
}

export function getDemoSnapshot() {
  if (!state) resetState(demoScenario());
  return buildSnapshot();
}

export function getDemoHistory() {
  if (!state) resetState(demoScenario());
  return currentHistory();
}

export function setScenario(scenario) {
  const next = scenario === "warning" || scenario === "critical" ? scenario : "healthy";
  setDemoScenario(next);
  resetState(next);
  return buildSnapshot();
}

export function startDemoStream(onSnapshot) {
  if (!state) resetState(demoScenario());
  onSnapshot(buildSnapshot());
  const timer = setInterval(() => {
    advance();
    onSnapshot(buildSnapshot());
  }, 5000);
  return () => clearInterval(timer);
}

export const DEMO_SCENARIOS = ["healthy", "warning", "critical"];

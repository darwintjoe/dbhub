// Demo API shim. Mirrors the real admin endpoints with simulated data.
// Never performs a real network request. Used by api.js when demo is active.

import { getDemoSnapshot, setScenario, demoScenario } from "./demo.js";

const pairings = new Map();
let pairingCounter = 0;

function params(path) {
  try { return new URL(path, window.location.origin).searchParams; }
  catch (e) { return new URLSearchParams(); }
}

function cleanPath(path) {
  try { return new URL(path, window.location.origin).pathname; }
  catch (e) { return String(path).split("?")[0]; }
}

function ok(data) { return Promise.resolve(data); }
function nowIso() { return new Date().toISOString(); }

function seedPairings() {
  // Nothing to seed; pairings are created on demand.
}

export function demoApi(path, options = {}) {
  const p = cleanPath(path);
  const q = params(path);
  const method = String(options.method || "GET").toUpperCase();
  const snapshot = getDemoSnapshot();

  /* ------------------------------- GET ---------------------------------- */
  if (method === "GET") {
    if (p === "/api/v1/admin/session") {
      return ok({ authenticated: true, setupRequired: false, csrfToken: "demo-csrf-token" });
    }
    if (p === "/api/v1/admin/overview") return ok(snapshot);
    if (p === "/api/v1/admin/health") return ok(snapshot.health);
    if (p === "/api/v1/admin/outbox") {
      return ok({ counts: snapshot.outbox.counts, lastErrors: snapshot.outbox.lastErrors, oldestPendingAgeMs: snapshot.outbox.oldestPendingAgeMs, lastSuccessAt: snapshot.outbox.lastSuccessAt });
    }
    if (p === "/api/v1/admin/devices") {
      let devices = (snapshot.devices || []).map((d) => ({ ...d }));
      const reason = q.get("reason");
      if (reason) devices = devices.filter((d) => d.quarantined > 0);
      return ok({ devices });
    }
    if (p === "/api/v1/admin/connectivity") {
      return ok({
        mode: snapshot.connectivity.mode,
        publicUrl: snapshot.connectivity.publicUrl,
        publicDomain: "hub.demo.example.com",
        publicPort: 8788,
        tunnel: snapshot.connectivity.tunnel,
        cloudflare: { binaryPath: "cloudflared", tunnelTokenFile: "", autoStart: true },
        mdns: { enabled: true },
      });
    }
    if (p === "/api/v1/admin/diagnostics") {
      return ok({
        hostname: "demo-hub",
        lanIps: ["192.168.1.50", "192.168.1.51"],
        macAddresses: ["00:11:22:33:44:55"],
        mdns: { enabled: true },
        adminPort: 8787,
        publicListener: { mode: snapshot.connectivity.mode, port: 8788 },
        tunnel: snapshot.connectivity.tunnel,
        serial: "demo-hub",
        version: "0.3.0-demo",
        recentErrors: [],
      });
    }
    if (p === "/api/v1/admin/backups") return ok({ items: snapshot.backup.items });
    if (p === "/api/v1/admin/audit") {
      const limit = Math.min(Number(q.get("limit") || 20), 200);
      const actions = ["backup.created", "chain.verified", "device.paired", "config.updated", "tunnel.restarted", "bundle.accepted"];
      const items = Array.from({ length: limit }, (_, i) => ({
        at: new Date(Date.now() - i * 37 * 60 * 1000).toISOString(),
        action: actions[i % actions.length],
        actor: "admin",
        detail: "Simulated audit entry",
      }));
      return ok({ items, total: 240, limit, offset: 0 });
    }
    if (p === "/api/v1/admin/quarantine") {
      const reason = q.get("reason");
      const deviceId = q.get("deviceId");
      const items = Array.from({ length: Math.min(snapshot.counts.quarantined, 20) }, (_, i) => ({
        bundleId: `bdl_quarantine_${i + 1}`,
        deviceId: i % 2 === 0 ? "dev_kasir1" : "dev_gudang",
        reason: i % 2 === 0 ? "duplicate_event" : "missing_parent",
        receivedAt: new Date(Date.now() - i * 44 * 60 * 1000).toISOString(),
        hubSeq: snapshot.chain.latestHubSeq - i,
        status: "quarantined",
      })).filter((it) => (!reason || it.reason === reason) && (!deviceId || it.deviceId === deviceId));
      return ok({ items, total: items.length, limit: 50, offset: 0 });
    }
    const qDetail = p.match(/^\/api\/v1\/admin\/quarantine\/([^/]+)$/);
    if (qDetail) {
      // Metadata only — payload is intentionally withheld in the demo UI.
      return ok({
        bundleId: decodeURIComponent(qDetail[1]), deviceId: "dev_kasir1",
        reason: "duplicate_event", status: "quarantined",
        receivedAt: nowIso(), hubSeq: snapshot.chain.latestHubSeq,
        note: "Payload hidden in demo mode.",
      });
    }
    if (p === "/api/v1/admin/config") {
      return ok({
        config: {
          companyId: "demo-company", replicaId: "demo-hub", port: 8787, host: "127.0.0.1",
          publicUrl: snapshot.connectivity.publicUrl, dataDir: "demo://data", logDir: "demo://logs",
          limits: { maxBodyBytes: 5242880, ratePerMinutePerDevice: 1000, ratePerMinutePerIp: 1000 },
          monitoring: { enabled: true, sampleIntervalMs: 5000, historyPoints: 120, hostCounters: true },
          backup: { dir: "demo://backups", retentionDays: 14, maxFiles: 20 },
          security: { trustProxy: false, adminAllowedCidrs: [], allowedOrigins: [] },
          quarantine: { pendingParentTimeoutMs: 86400000 },
          storage: { target: snapshot.storage.target, folderPath: snapshot.storage.folderPath },
        },
        path: "demo://config.json", hash: "demo-config-hash",
      });
    }
    if (p === "/api/v1/admin/logs") {
      return ok({
        files: [{ name: "hub-2026-11-19.log", size: 48210 }, { name: "hub-2026-11-18.log", size: 33990 }],
        file: "hub-2026-11-19.log",
        lines: [
          '{"level":30,"time":"2026-11-19T08:00:00Z","msg":"demo log line 1"}',
          '{"level":30,"time":"2026-11-19T08:00:05Z","msg":"demo log line 2"}',
          '{"level":40,"time":"2026-11-19T08:00:10Z","msg":"demo warning (simulated)"}',
        ],
      });
    }
    const pairingMatch = p.match(/^\/api\/v1\/admin\/pairings\/([^/]+)$/);
    if (pairingMatch) {
      const id = decodeURIComponent(pairingMatch[1]);
      const rec = pairings.get(id);
      if (!rec) return Promise.reject(new Error("Pairing not found"));
      rec.polls++;
      let status = rec.status;
      if (rec.polls >= 2 && status === "pending") status = rec.status = "awaiting_approval";
      if (rec.approved && rec.polls >= 3) status = rec.status = "claimed";
      return ok({ pairingId: id, status, code: rec.code, expiresAt: rec.expiresAt, deviceId: status === "claimed" ? "dev_demo_new" : null });
    }
    return ok({});
  }

  /* ------------------------------ writes --------------------------------- */
  if (p === "/api/v1/admin/session" && method === "POST") {
    return ok({ csrfToken: "demo-csrf-token", authenticated: true });
  }
  if (p === "/api/v1/admin/session" && method === "DELETE") return ok({ ok: true });
  if (p === "/api/v1/admin/setup") {
    return ok({ recoveryCode: "DEMO-RECOVERY-CODE-KEEP-IT-SAFE", csrfToken: "demo-csrf-token" });
  }
  if (p === "/api/v1/admin/maintenance/verify-chain") {
    const cfg = snapshot.scenario;
    const okChain = cfg !== "critical" ? true : false;
    return ok({ ok: okChain, checked: okChain ? snapshot.chain.latestAcceptedSeq : 940, verifiedAt: nowIso(), firstBadAcceptedSeq: okChain ? null : 941, firstBadHubSeq: okChain ? null : 945 });
  }
  if (p === "/api/v1/admin/maintenance/checkpoint") return ok({ ok: true, at: nowIso() });
  if (p === "/api/v1/admin/backups" && method === "POST") {
    const name = `hub-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}.sqlite`;
    return ok({ name, path: `demo://backups/${name}`, ok: true, size: snapshot.db.hubBytes });
  }
  if (p === "/api/v1/admin/connectivity/restart") {
    snapshot.connectivity.tunnel.status = "starting";
    snapshot.connectivity.tunnel.lastStartAt = nowIso();
    setTimeout(() => { snapshot.connectivity.tunnel.status = "connected"; snapshot.connectivity.tunnel.lastError = null; }, 300);
    return ok({ ...snapshot.connectivity.tunnel });
  }
  if (p === "/api/v1/admin/connectivity/test") {
    return ok({ ok: true, latencyMs: 42, detail: "Simulated tunnel test (no network request)" });
  }
  if (p === "/api/v1/admin/connectivity/rotate-token") return ok({ ok: true, note: "Simulated — no token shown" });
  if (p === "/api/v1/admin/connectivity" && method === "PUT" || p === "/api/v1/admin/connectivity" && method === "PATCH") {
    return ok({ ok: true, hotApplied: ["connectivity"] });
  }

  const deviceCreate = p === "/api/v1/admin/devices" && method === "POST";
  if (deviceCreate) {
    let body = {};
    try { body = JSON.parse(options.body || "{}"); } catch (e) { /* ignore */ }
    const prefix = String(body.prefix || "NEW").slice(0, 8).toUpperCase();
    return ok({ deviceId: `dev_demo_${++pairingCounter}`, prefix, hubUrl: "http://demo-hub.local:8787", tokenShown: false });
  }
  let m = p.match(/^\/api\/v1\/admin\/devices\/([^/]+)\/(rotate-token|revoke)$/);
  if (m) return ok({ ok: true, deviceId: decodeURIComponent(m[1]), tokenShown: false });

  if (p === "/api/v1/admin/config" && (method === "PUT" || method === "POST")) {
    return ok({ ok: true, hash: "demo-config-hash", hotApplied: ["monitoring"], restartRequired: [] });
  }
  if (p === "/api/v1/admin/config/validate") return ok({ ok: true, errors: [] });
  if (p === "/api/v1/admin/config/rotate-token") return ok({ ok: true, note: "Simulated — no token shown" });

  if (p === "/api/v1/admin/pairings" && method === "POST") {
    let body = {};
    try { body = JSON.parse(options.body || "{}"); } catch (e) { /* ignore */ }
    const id = `pair_demo_${++pairingCounter}`;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const rec = { id, code, status: "pending", approved: false, polls: 0, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), label: body.label || "Device" };
    pairings.set(id, rec);
    return ok({ pairingId: id, code, expiresAt: rec.expiresAt, status: "pending", network: body.network || "lan" });
  }
  m = p.match(/^\/api\/v1\/admin\/pairings\/([^/]+)\/approve$/);
  if (m) {
    const rec = pairings.get(decodeURIComponent(m[1]));
    if (rec) rec.approved = true;
    return ok({ ok: true, status: "claimed" });
  }
  m = p.match(/^\/api\/v1\/admin\/pairings\/([^/]+)$/);
  if (m && method === "DELETE") {
    pairings.delete(decodeURIComponent(m[1]));
    return ok({ ok: true });
  }

  if (p === "/api/v1/admin/demo/scenario" && method === "POST") {
    let body = {};
    try { body = JSON.parse(options.body || "{}"); } catch (e) { /* ignore */ }
    return ok({ scenario: setScenario(body.scenario || demoScenario()), ok: true });
  }

  seedPairings();
  return ok({});
}

export function demoScenarioList() {
  return ["healthy", "warning", "critical"];
}

// Centralized thresholds, severity mapping and plain-language labels.
// Pure functions, no DOM.

export const THRESHOLDS = {
  cpu: { warning: 85, critical: 95 },
  memory: { warning: 85, critical: 95 },
  disk: { warning: 80, critical: 90, minFreeBytes: 10 * 1024 * 1024 * 1024 },
  network: { warning: 80 },
  outbox: { failedWarning: 1, pendingAgeMs: 10 * 60 * 1000 },
  chain: { staleMs: 24 * 60 * 60 * 1000 },
  backup: { warningMs: 24 * 60 * 60 * 1000 },
  device: { offlineMs: 5 * 60 * 1000 },
};

const ORDER = { ok: 0, info: 1, warning: 2, critical: 3 };

export function severityClass(severity) {
  return ORDER[severity] === undefined ? "info" : severity;
}

export function severityRank(severity) {
  return ORDER[severity] ?? 1;
}

export function worstSeverity(severities) {
  let worst = "ok";
  for (const s of severities || []) {
    if (severityRank(s) > severityRank(worst)) worst = s;
  }
  return worst;
}

export function iconForSeverity(severity) {
  switch (severityClass(severity)) {
    case "ok": return "✓";
    case "warning": return "!";
    case "critical": return "✕";
    case "info": return "i";
    default: return "i";
  }
}

export function labelForSeverity(severity) {
  switch (severityClass(severity)) {
    case "ok": return "OK";
    case "warning": return "Warning";
    case "critical": return "Critical";
    case "info": return "Info";
    default: return "Info";
  }
}

export function percentSeverity(kind, value) {
  const t = THRESHOLDS[kind];
  const n = Number(value);
  if (!t || !Number.isFinite(n)) return "info";
  if (n >= t.critical) return "critical";
  if (n >= t.warning) return "warning";
  return "ok";
}

export function diskSeverity(usedPercent, freeBytes) {
  const used = Number(usedPercent);
  const free = Number(freeBytes);
  if (Number.isFinite(free) && free < THRESHOLDS.disk.minFreeBytes) return "critical";
  if (Number.isFinite(used)) {
    if (used >= THRESHOLDS.disk.critical) return "critical";
    if (used >= THRESHOLDS.disk.warning) return "warning";
  }
  if (!Number.isFinite(used) && !Number.isFinite(free)) return "info";
  return "ok";
}

export function networkSeverity(utilPercent) {
  return percentSeverity("network", utilPercent);
}

export function outboxSeverity(counts, oldestPendingAgeMs) {
  const c = counts || {};
  const failed = Number(c.failed ?? 0);
  const age = Number(oldestPendingAgeMs);
  if (failed > 0) return "warning";
  if (Number.isFinite(age) && age > THRESHOLDS.outbox.pendingAgeMs) return "warning";
  return "ok";
}

export function chainSeverity(verify, verifiedAt) {
  const v = verify || {};
  if (v.ok === false) return "critical";
  if (v.ok !== true) return "warning";
  if (!verifiedAt) return "warning";
  const t = Date.parse(verifiedAt);
  if (!Number.isFinite(t)) return "warning";
  if (Date.now() - t > THRESHOLDS.chain.staleMs) return "warning";
  return "ok";
}

export function backupSeverity(lastAt) {
  if (!lastAt) return "critical";
  const t = Date.parse(lastAt);
  if (!Number.isFinite(t)) return "critical";
  if (Date.now() - t > THRESHOLDS.backup.warningMs) return "warning";
  return "ok";
}

export function deviceSeverity(lastSeenAt) {
  if (!lastSeenAt) return "warning";
  const t = Date.parse(lastSeenAt);
  if (!Number.isFinite(t)) return "warning";
  if (Date.now() - t > THRESHOLDS.device.offlineMs) return "warning";
  return "ok";
}

export function tunnelSeverity(tunnel) {
  const status = (tunnel && tunnel.status) || "disabled";
  if (status === "error" || status === "not_installed") return "warning";
  if (status === "connected") return "ok";
  return "info";
}

// Plain-language labels for technical codes. Never leak jargon to end users.
const PLAIN_LABELS = {
  hash_mismatch: "Data did not match its fingerprint",
  duplicate_event: "Duplicate record",
  missing_parent: "Waiting on a missing earlier record",
  schema_incompatibility: "Record format not supported",
  migration_invalid_payload: "Unreadable record",
  revoked_device: "From a removed device",
  accepted: "Accepted",
  pending_parent: "Waiting for earlier data",
  quarantined: "Needs review",
  done: "Uploaded",
  pending: "Waiting",
  uploading: "Uploading",
  failed: "Needs retry",
};

export function plainLabel(code) {
  if (!code) return "Unknown";
  return PLAIN_LABELS[String(code)] || String(code).replace(/_/g, " ");
}

// Derive alert list from a normalized overview snapshot.
export function deriveAlerts(sample) {
  const s = sample || {};
  const alerts = [];
  const add = (severity, code, text) => alerts.push({ severity: severityClass(severity), code, text });

  for (const reason of s.health?.reasons || []) {
    add(reason.severity, reason.code, reason.message || plainLabel(reason.code));
  }

  const host = s.host || {};
  const cpu = s.host?.cpuPercentTotal ?? s.process?.cpuPercent;
  if (Number.isFinite(cpu)) {
    const sev = percentSeverity("cpu", cpu);
    if (sev !== "ok") add(sev, "CPU", `Processor usage high (${Math.round(cpu)}%)`);
  }
  const memTotal = Number(host.memoryTotalBytes);
  const memUsed = Number(host.memoryUsedBytes);
  if (memTotal > 0 && Number.isFinite(memUsed)) {
    const pct = (memUsed / memTotal) * 100;
    const sev = percentSeverity("memory", pct);
    if (sev !== "ok") add(sev, "MEMORY", `Memory usage high (${Math.round(pct)}%)`);
  }
  for (const disk of s.disks || []) {
    const sev = diskSeverity(disk.usedPercent, disk.freeBytes);
    if (sev !== "ok") add(sev, "DISK", `Disk ${disk.mount || "volume"} nearly full`);
  }
  for (const nic of s.network || []) {
    const util = nicUtilization(nic);
    if (util === null) continue;
    const sev = networkSeverity(util);
    if (sev !== "ok") add(sev, "NETWORK", `Network ${nic.name || "adapter"} busy`);
  }

  const outbox = s.outbox?.counts || {};
  const osev = outboxSeverity(outbox, s.outbox?.oldestPendingAgeMs);
  if (osev !== "ok") {
    add(osev, "OUTBOX", Number(outbox.failed) > 0
      ? `${outbox.failed} upload(s) need retry`
      : "Upload queue has been waiting over 10 minutes");
  }

  const csev = chainSeverity(s.chain?.verify, s.chain?.verify?.verifiedAt);
  if (csev !== "ok") {
    add(csev, "CHAIN", s.chain?.verify?.ok === false ? "Data integrity check failed" : "Data integrity check is out of date");
  }

  const bsev = backupSeverity(s.backup?.lastAt);
  if (bsev !== "ok") add(bsev, "BACKUP", bsev === "critical" ? "No backup has been taken yet" : "Last backup is over a day old");

  const tsev = tunnelSeverity(s.connectivity?.tunnel);
  if (tsev === "warning") add(tsev, "TUNNEL", "Remote access needs attention");

  for (const d of s.devices || []) {
    if (d.online === false && deviceSeverity(d.lastSeenAt) !== "ok") {
      add("warning", "DEVICE", `${d.label || d.prefix || "Device"} has been offline over 5 minutes`);
      break;
    }
  }

  const quarantined = Number(s.counts?.quarantined ?? 0);
  if (quarantined > 0) add("warning", "QUARANTINE", `${quarantined} item(s) need review`);

  return alerts;
}

export function nicUtilization(nic) {
  if (!nic) return null;
  const rx = Number(nic.rxBytesPerSec ?? 0);
  const tx = Number(nic.txBytesPerSec ?? 0);
  const speed = Number(nic.linkSpeedMbps ?? 0);
  if (!Number.isFinite(speed) || speed <= 0) return null;
  const bitsPerSec = (rx + tx) * 8;
  return (bitsPerSec / (speed * 1000 * 1000)) * 100;
}

// Data Safety Score. Pure function — no DOM, no side effects.
// Input is a normalized overview snapshot (live or demo).

import { THRESHOLDS } from "./status.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isRecent(iso, maxAgeMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= maxAgeMs;
}

/**
 * Compute a 0-100 Data Safety Score with an explicit breakdown.
 * Returns { score, label, breakdown: [{ key, label, points, max, severity, detail }] }.
 */
export function computeDataSafetyScore(snapshot) {
  const s = snapshot || {};
  const breakdown = [];
  const add = (key, label, points, max, severity, detail) => {
    breakdown.push({ key, label, points: Math.round(points), max, severity, detail: detail || "" });
  };

  // 1. Hash chain: verified OK (25) + fresh (10) = 35
  const verify = s.chain?.verify || {};
  const verifiedAt = verify.verifiedAt || s.service?.lastChainVerifyAt || null;
  const chainOk = verify.ok === true;
  const chainFresh = chainOk && isRecent(verifiedAt, THRESHOLDS.chain.staleMs);
  const chainPoints = (chainOk ? 25 : 0) + (chainFresh ? 10 : 0);
  add("chain", "Integrity check", chainPoints, 35,
    verify.ok === false ? "critical" : chainFresh ? "ok" : "warning",
    verify.ok === false ? "Integrity check failed" : chainFresh ? "Verified recently" : "Not verified recently");

  // 2. Backup recent = 20
  const lastBackup = s.backup?.lastAt || s.service?.lastBackupAt || null;
  const backupRecent = isRecent(lastBackup, THRESHOLDS.backup.warningMs);
  add("backup", "Recent backup", backupRecent ? 20 : 0, 20,
    !lastBackup ? "critical" : backupRecent ? "ok" : "warning",
    !lastBackup ? "No backup yet" : backupRecent ? "Backup is current" : "Backup is overdue");

  // 3. Replica / SAL configured and outbox healthy = 20.
  // A local folder replica is real redundancy, but it is NOT a cloud/SAL connection.
  const replica = s.replica || {};
  const sal = replica.sal || {};
  const salConnected = sal.connected === true;
  const hasLocalReplica = replica.target === "folder";
  const outbox = s.outbox?.counts || {};
  const failed = num(outbox.failed) ?? 0;
  const stalePending = num(s.outbox?.oldestPendingAgeMs);
  const outboxHealthy = failed === 0 && !(stalePending !== null && stalePending > THRESHOLDS.outbox.pendingAgeMs);
  const replicaPoints = Math.min(20,
    (salConnected ? 12 : 0) + (hasLocalReplica ? 6 : 0) + (outboxHealthy ? 8 : 0));
  add("replica", "Replica & uploads", replicaPoints, 20,
    !salConnected ? "warning" : outboxHealthy ? "ok" : "warning",
    salConnected
      ? (outboxHealthy ? "Upload queue healthy" : "Upload queue needs attention")
      : `Not configured (cloud)${hasLocalReplica ? " · local folder replica" : ""}`);

  // 4. Disk free >= 10GB and used < 90% = 15
  const disk = (s.disks && s.disks[0]) || s.storage || {};
  const free = num(disk.freeBytes);
  const usedPct = num(disk.usedPercent);
  const diskOk = free !== null && free >= THRESHOLDS.disk.minFreeBytes &&
    (usedPct === null || usedPct < THRESHOLDS.disk.critical);
  add("disk", "Free storage", diskOk ? 15 : 0, 15,
    diskOk ? "ok" : free !== null && free < THRESHOLDS.disk.minFreeBytes ? "critical" : "warning",
    diskOk ? "Plenty of free space" : "Low free space");

  // 5. Recent ingest / devices online = 10
  const devices = s.devices || [];
  const online = devices.filter((d) => d && d.online === true).length;
  const lastIngest = s.service?.lastIngestAt || s.chain?.lastAcceptedReceivedAt || null;
  const activityRecent = isRecent(lastIngest, 24 * 60 * 60 * 1000) || online > 0 || num(s.counts?.accepted) > 0;
  add("activity", "Recent activity", activityRecent ? 10 : 0, 10,
    activityRecent ? "ok" : "warning",
    activityRecent ? "Hub is receiving data" : "No recent activity");

  let score = breakdown.reduce((sum, b) => sum + b.points, 0);

  // Penalties
  if (failed > 0) {
    const penalty = Math.min(10, failed * 3);
    score -= penalty;
    add("failedOutbox", "Failed uploads", -penalty, 0, "warning", `${failed} failed row(s)`);
  }
  if (stalePending !== null && stalePending > THRESHOLDS.outbox.pendingAgeMs) {
    score -= 5;
    add("stalePending", "Waiting uploads", -5, 0, "warning", "Oldest item over 10 minutes");
  }
  const quarantined = num(s.counts?.quarantined) ?? 0;
  if (quarantined > 0) {
    const penalty = Math.min(5, quarantined);
    score -= penalty;
    add("quarantine", "Items to review", -penalty, 0, "warning", `${quarantined} item(s)`);
  }

  // Replica health (PRD §29) caps the score so a broken safety posture cannot
  // be hidden by otherwise healthy host metrics. All text is plain language.
  const safety = (s.replica && s.replica.health) || s.dataSafety || null;
  if (safety && safety.level === "CRITICAL") score = Math.min(score, 35);
  else if (safety && safety.level === "WARNING") score = Math.min(score, 75);

  score = Math.max(0, Math.min(100, Math.round(score)));

  let label;
  if (score >= 90) label = "Well protected";
  else if (score >= 70) label = "Mostly protected";
  else if (score >= 40) label = "Needs attention";
  else label = "At risk";

  return { score, label, breakdown };
}

export default computeDataSafetyScore;

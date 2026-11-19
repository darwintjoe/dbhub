import { describe, expect, it } from "vitest";
import {
  formatBytes, formatRate, formatPercent, formatDuration, formatAge, timeAgo,
} from "../public/admin/lib/format.js";
import {
  THRESHOLDS, percentSeverity, diskSeverity, chainSeverity, backupSeverity,
  deriveAlerts, nicUtilization, severityClass, iconForSeverity, plainLabel,
} from "../public/admin/lib/status.js";
import { computeDataSafetyScore } from "../public/admin/lib/score.js";

const recent = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("admin format helpers", () => {
  it("formats bytes and rates", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
    expect(formatRate(1024)).toBe("1.0 KB/s");
    expect(formatBytes(null)).toBe("—");
  });

  it("formats percentages, durations and ages", () => {
    expect(formatPercent(42)).toBe("42%");
    expect(formatPercent(null)).toBe("—");
    expect(formatDuration(3661_000)).toBe("1h 1m");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatAge(null)).toBe("—");
    expect(timeAgo(null)).toBe("Never");
  });
});

describe("admin status thresholds", () => {
  it("CPU/memory warning above 85 and critical above 95", () => {
    expect(THRESHOLDS.cpu.warning).toBe(85);
    expect(percentSeverity("cpu", 50)).toBe("ok");
    expect(percentSeverity("cpu", 90)).toBe("warning");
    expect(percentSeverity("cpu", 96)).toBe("critical");
    expect(percentSeverity("memory", 95)).toBe("critical");
  });

  it("disk warns at 80 and treats under 10GB free as critical", () => {
    expect(diskSeverity(75, 500e9)).toBe("ok");
    expect(diskSeverity(85, 500e9)).toBe("warning");
    expect(diskSeverity(93, 500e9)).toBe("critical");
    expect(diskSeverity(20, 1e9)).toBe("critical");
  });

  it("chain, backup and NIC severities", () => {
    expect(chainSeverity({ ok: false }, recent())).toBe("critical");
    expect(chainSeverity({ ok: true }, null)).toBe("warning");
    expect(chainSeverity({ ok: true }, recent())).toBe("ok");
    expect(backupSeverity(null)).toBe("critical");
    expect(backupSeverity(recent())).toBe("ok");
    expect(nicUtilization({ rxBytesPerSec: 100e6, txBytesPerSec: 0, linkSpeedMbps: 1000 })).toBe(80);
  });

  it("uses icons and plain labels, never colour alone", () => {
    expect(iconForSeverity("critical")).toBe("✕");
    expect(iconForSeverity("ok")).toBe("✓");
    expect(severityClass("nonsense")).toBe("info");
    expect(plainLabel("hash_mismatch")).toBe("Data did not match its fingerprint");
  });

  it("derives plain-language alerts from derived signals", () => {
    const alerts = deriveAlerts({
      health: { status: "degraded", reasons: [] },
      host: { cpuPercentTotal: 50, memoryTotalBytes: 100, memoryUsedBytes: 20 },
      disks: [{ mount: "C:", usedPercent: 50, freeBytes: 500e9 }],
      network: [],
      outbox: { counts: { failed: 2, pending: 0, done: 1, uploading: 0 } },
      chain: { verify: { ok: true, verifiedAt: recent() } },
      backup: { lastAt: recent() },
      devices: [],
      counts: { quarantined: 0 },
    });
    expect(alerts.some((a) => a.code === "OUTBOX")).toBe(true);
    expect(alerts.every((a) => typeof a.text === "string" && a.text.length > 0)).toBe(true);
  });
});

describe("data safety score", () => {
  it("scores a fully protected hub at 100", () => {
    const result = computeDataSafetyScore({
      chain: { verify: { ok: true, verifiedAt: recent() } },
      backup: { lastAt: recent() },
      replica: { sal: { connected: true } },
      outbox: { counts: { pending: 1, failed: 0, done: 10, uploading: 0 }, oldestPendingAgeMs: 60000 },
      disks: [{ freeBytes: 500e9, usedPercent: 38 }],
      devices: [{ online: true }],
      counts: { accepted: 10, quarantined: 0 },
    });
    expect(result.score).toBe(100);
    expect(result.label).toBe("Well protected");
    expect(result.breakdown.length).toBeGreaterThanOrEqual(5);
    expect(result.breakdown.every((b) => typeof b.label === "string")).toBe(true);
  });

  it("scores an unhealthy hub low and adds penalties", () => {
    const result = computeDataSafetyScore({
      chain: { verify: { ok: false, verifiedAt: null } },
      backup: { lastAt: null },
      replica: { sal: { connected: false } },
      outbox: { counts: { pending: 30, failed: 4, done: 0, uploading: 0 }, oldestPendingAgeMs: 45 * 60 * 1000 },
      disks: [{ freeBytes: 1e9, usedPercent: 95 }],
      devices: [{ online: false }],
      counts: { accepted: 10, quarantined: 12 },
    });
    expect(result.score).toBe(0);
    expect(result.label).toBe("At risk");
    expect(result.breakdown.some((b) => b.key === "failedOutbox" && b.points < 0)).toBe(true);
  });

  it("gives a local folder replica credit without implying cloud SAL is connected", () => {
    const result = computeDataSafetyScore({
      chain: { verify: { ok: true, verifiedAt: recent() } },
      backup: { lastAt: recent() },
      replica: {
        target: "folder",
        sal: { connected: false, health: "Not configured" },
        manifest: { aligned: null, localOnly: true },
        numberRelay: { active: false },
        monitored: 1,
        total: 4,
      },
      outbox: { counts: { pending: 1, failed: 0, done: 10, uploading: 0 }, oldestPendingAgeMs: 60000 },
      disks: [{ freeBytes: 500e9, usedPercent: 38 }],
      devices: [{ online: true }],
      counts: { accepted: 10, quarantined: 0 },
    });
    const replicaBreakdown = result.breakdown.find((b) => b.key === "replica");
    expect(replicaBreakdown).toBeTruthy();
    expect(replicaBreakdown!.points).toBeGreaterThan(0);
    expect(replicaBreakdown!.detail).toContain("Not configured");
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);

    // Folder target alone must never be reported as a cloud/SAL connection.
    const noCloud = computeDataSafetyScore({
      replica: { target: "folder", sal: { connected: false } },
      outbox: { counts: { failed: 0 }, oldestPendingAgeMs: 1000 },
    });
    const chip = noCloud.breakdown.find((b) => b.key === "replica")!;
    expect(chip.severity).toBe("warning");
    expect(chip.detail).toContain("Not configured");
  });

  it("never produces NaN or out-of-range values", () => {
    const result = computeDataSafetyScore({});
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("maps score bands to labels", () => {
    const base = {
      chain: { verify: { ok: true, verifiedAt: recent() } },
      backup: { lastAt: recent() },
      replica: { sal: { connected: true } },
      outbox: { counts: { failed: 0 }, oldestPendingAgeMs: 1000 },
      disks: [{ freeBytes: 500e9, usedPercent: 30 }],
      devices: [{ online: true }],
      counts: { quarantined: 0 },
    };
    expect(computeDataSafetyScore(base).label).toBe("Well protected");
    expect(computeDataSafetyScore({ ...base, backup: { lastAt: null } }).label).toBe("Mostly protected");
    expect(computeDataSafetyScore({ ...base, backup: { lastAt: null }, chain: { verify: { ok: true, verifiedAt: null } }, disks: [{ freeBytes: 1e9, usedPercent: 95 }] }).score).toBeLessThan(70);
  });
});

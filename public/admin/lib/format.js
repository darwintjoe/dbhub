// Pure formatting helpers. No DOM access. All functions tolerate null/undefined.

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatBytes(bytes, digits = 1) {
  let n = finite(bytes);
  if (n === null || n < 0) return "—";
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(n)} B`;
  return `${n.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSec, digits = 1) {
  const n = finite(bytesPerSec);
  if (n === null) return "—";
  return `${formatBytes(Math.abs(n), digits)}/s`;
}

export function formatPercent(value, digits = 0) {
  const n = finite(value);
  if (n === null) return "—";
  return `${n.toFixed(digits)}%`;
}

export function formatNumber(value) {
  const n = finite(value);
  if (n === null) return "—";
  return n.toLocaleString("en-US");
}

export function formatDuration(ms) {
  let n = finite(ms);
  if (n === null || n < 0) return "—";
  n = Math.floor(n / 1000);
  if (n < 60) return `${n}s`;
  const sec = n % 60;
  const min = Math.floor(n / 60) % 60;
  const hours = Math.floor(n / 3600) % 24;
  const days = Math.floor(n / 86400);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

export function formatAge(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  return formatDuration(diff);
}

export function timeAgo(iso) {
  const age = formatAge(iso);
  return age === "—" ? "Never" : `${age} ago`;
}

export function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function shortHash(hash) {
  if (!hash || typeof hash !== "string") return "—";
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

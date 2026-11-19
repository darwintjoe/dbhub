// SVG chart kit. No canvas, no external assets, no inline style attributes.
// All colours come from CSS classes so dark/light themes work automatically.

import { severityClass, percentSeverity } from "./lib/status.js";

const NS = "http://www.w3.org/2000/svg";
const DEFAULT_THRESHOLDS = { warning: 80, critical: 95 };

const instances = new Map();
let observer = null;
let resizeBound = false;
let themeBound = false;

function svgEl(tag, attrs = {}, text = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function srSummary(node, text) {
  let p = node.querySelector(":scope > .sr-only");
  if (!p) {
    p = document.createElement("p");
    p.className = "sr-only";
    node.appendChild(p);
  }
  p.textContent = text;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function measure(node, fallbackW, fallbackH) {
  const w = Math.max(40, Number(node.clientWidth) || fallbackW);
  const h = Math.max(40, Number(node.clientHeight) || fallbackH);
  return { w, h };
}

function emptySvg(node, w, h, message) {
  clearNode(node);
  const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${w} ${h}`, width: "100%", height: "100%", role: "img", "aria-label": message });
  svg.appendChild(svgEl("text", { x: w / 2, y: h / 2, class: "chart-empty-text", "text-anchor": "middle", "dominant-baseline": "middle" }, message));
  node.appendChild(svg);
  srSummary(node, message);
}

function sevOf(value, thresholds, unknown) {
  const n = Number(value);
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (!Number.isFinite(n)) return unknown ? "info" : "ok";
  if (Number.isFinite(t.critical) && n >= t.critical) return "critical";
  if (Number.isFinite(t.warning) && n >= t.warning) return "warning";
  return "ok";
}

/* ---------------------------------- gauge --------------------------------- */

function drawGauge(rec, w, h) {
  const o = rec.options;
  const value = Number(o.value);
  const min = Number.isFinite(Number(o.min)) ? Number(o.min) : 0;
  const max = Number.isFinite(Number(o.max)) ? Number(o.max) : 100;
  const node = rec.node;
  const known = Number.isFinite(value) && !o.unknown && max > min;

  node.setAttribute("role", "meter");
  node.setAttribute("aria-valuemin", String(min));
  node.setAttribute("aria-valuemax", String(max));
  node.setAttribute("aria-valuenow", known ? String(value) : "0");
  node.setAttribute("aria-label", `${o.label || "Gauge"}${known ? ` ${Math.round(value)}${o.unit || ""}` : " no data"}`);

  if (!known) {
    emptySvg(node, w, h, "Collecting…");
    return;
  }

  clearNode(node);
  const cx = w / 2;
  const cy = h * 0.82;
  const r = Math.max(20, Math.min(w / 2 - 12, h * 0.78 - 8));
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const length = Math.PI * r;

  const svg = svgEl("svg", { class: "chart-svg chart-gauge", viewBox: `0 0 ${w} ${h}`, width: "100%", height: "100%" });
  svg.appendChild(svgEl("path", { class: "chart-track", d: arc, fill: "none", "stroke-width": Math.max(8, r * 0.14), "stroke-linecap": "round" }));

  const severity = o.severity || sevOf(value, o.thresholds, false);
  svg.appendChild(svgEl("path", {
    class: `chart-value-arc chart-sev-${severityClass(severity)}`,
    d: arc,
    fill: "none",
    "stroke-width": Math.max(8, r * 0.14),
    "stroke-linecap": "round",
    "stroke-dasharray": `${(ratio * length).toFixed(2)} ${length.toFixed(2)}`,
  }));

  // ticks at 0 / 25 / 50 / 75 / 100
  for (let i = 0; i <= 4; i++) {
    const angle = Math.PI - (i / 4) * Math.PI;
    const ix = cx + Math.cos(angle) * r;
    const iy = cy - Math.sin(angle) * r;
    const ox = cx + Math.cos(angle) * (r + 5);
    const oy = cy - Math.sin(angle) * (r + 5);
    svg.appendChild(svgEl("line", { class: "chart-tick", x1: ix, y1: iy, x2: ox, y2: oy }));
  }

  svg.appendChild(svgEl("text", { class: "chart-value-text", x: cx, y: cy - r * 0.18, "text-anchor": "middle", "dominant-baseline": "middle" }, `${Math.round(value)}${o.unit || ""}`));
  if (o.label) svg.appendChild(svgEl("text", { class: "chart-label", x: cx, y: cy + 16, "text-anchor": "middle" }, o.label));

  node.appendChild(svg);
  srSummary(node, `${o.label || "Gauge"}: ${Math.round(value)}${o.unit || ""} of ${max}${o.unit || ""}`);
}

/* -------------------------------- line chart ------------------------------- */

function niceNumber(v, decimals) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(decimals)}G`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(decimals)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(decimals)}k`;
  return v.toFixed(decimals);
}

function drawLineChart(rec, w, h) {
  const o = rec.options;
  const node = rec.node;
  const series = (o.series || []).filter((s) => s && Array.isArray(s.values) && s.values.length > 0);
  const numeric = [];
  for (const s of series) for (const v of s.values) if (Number.isFinite(Number(v))) numeric.push(Number(v));
  if (series.length === 0 || numeric.length === 0) {
    emptySvg(node, w, h, "Collecting…");
    return;
  }

  let min = Number(o.min);
  let max = Number(o.max);
  const isPercent = o.unit === "%";
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    if (isPercent) {
      min = 0; max = 100;
    } else {
      min = Math.min(...numeric);
      max = Math.max(...numeric);
      if (min === max) { min -= Math.abs(min) * 0.1 || 1; max += Math.abs(max) * 0.1 || 1; }
      const pad = (max - min) * 0.12;
      min -= pad; max += pad;
    }
  }
  if (max <= min) max = min + 1;

  const legendH = o.legend && series.length ? 18 : 0;
  const m = { left: 46, right: 14, top: 10, bottom: 22 };
  const pw = Math.max(20, w - m.left - m.right);
  const ph = Math.max(20, h - m.top - m.bottom - legendH);
  const count = Math.max(...series.map((s) => s.values.length));
  const xAt = (i) => m.left + (count <= 1 ? pw / 2 : (i / (count - 1)) * pw);
  const yAt = (v) => m.top + ph - ((Number(v) - min) / (max - min)) * ph;

  clearNode(node);
  const svg = svgEl("svg", { class: "chart-svg chart-line", viewBox: `0 0 ${w} ${h}`, width: "100%", height: "100%", role: "img" });

  // grid + y axis labels
  for (let i = 0; i <= 4; i++) {
    const gy = m.top + (i / 4) * ph;
    const gv = max - (i / 4) * (max - min);
    svg.appendChild(svgEl("line", { class: "chart-grid", x1: m.left, y1: gy, x2: m.left + pw, y2: gy }));
    svg.appendChild(svgEl("text", { class: "chart-axis", x: m.left - 6, y: gy + 3, "text-anchor": "end" }, niceNumber(gv, isPercent ? 0 : 1)));
  }

  // x axis labels
  const labels = o.timeLabels || [];
  if (labels.length) {
    const step = Math.max(1, Math.ceil(labels.length / 5));
    for (let i = 0; i < labels.length; i += step) {
      svg.appendChild(svgEl("text", { class: "chart-axis", x: xAt(i), y: h - m.bottom + 15, "text-anchor": "middle" }, String(labels[i])));
    }
  }
  svg.appendChild(svgEl("line", { class: "chart-axis-line", x1: m.left, y1: m.top + ph, x2: m.left + pw, y2: m.top + ph }));

  series.forEach((s, idx) => {
    const vals = s.values.map((v) => (Number.isFinite(Number(v)) ? Number(v) : null));
    if (s.fill) {
      const pts = vals.map((v, i) => (v === null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)).filter(Boolean);
      if (pts.length > 1) {
        const area = `M ${pts[0]} L ${pts.slice(1).join(" L ")} L ${xAt(vals.length - 1)},${(m.top + ph).toFixed(1)} L ${xAt(0)},${(m.top + ph).toFixed(1)} Z`;
        svg.appendChild(svgEl("path", { class: `chart-area area-${idx % 6}`, d: area }));
      }
    }
    const pts = vals.map((v, i) => (v === null ? null : `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)).filter(Boolean);
    if (pts.length > 0) {
      svg.appendChild(svgEl("path", { class: `chart-line series-${idx % 6}`, d: pts.join(" "), fill: "none" }));
    }
    const lastIdx = vals.findLastIndex ? vals.findLastIndex((v) => v !== null) : vals.length - 1;
    if (lastIdx >= 0 && vals[lastIdx] !== null) {
      svg.appendChild(svgEl("circle", { class: `chart-dot series-${idx % 6}`, cx: xAt(lastIdx), cy: yAt(vals[lastIdx]), r: 3.5 }));
    }
  });

  // hover tooltip
  const overlay = svgEl("rect", { class: "chart-overlay", x: m.left, y: m.top, width: pw, height: ph, fill: "transparent" });
  const tipWidth = 132;
  const tipHeight = 16 + series.length * 14;
  const tip = svgEl("g", { class: "chart-tooltip", visibility: "hidden" });
  tip.appendChild(svgEl("rect", { class: "chart-tooltip-bg", x: 0, y: 0, width: tipWidth, height: tipHeight, rx: 6 }));
  const tipTitle = svgEl("text", { class: "chart-tooltip-text chart-tooltip-title", x: 7, y: 13 });
  tip.appendChild(tipTitle);
  const tipLines = series.map((s, idx) => {
    const t = svgEl("text", { class: `chart-tooltip-text series-${idx % 6}`, x: 7, y: 27 + idx * 14 });
    tip.appendChild(t);
    return t;
  });

  const onMove = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((event.clientX - rect.left) / rect.width) * w;
    if (px < m.left || px > m.left + pw) { tip.setAttribute("visibility", "hidden"); return; }
    let idx = count <= 1 ? 0 : Math.round(((px - m.left) / pw) * (count - 1));
    idx = Math.max(0, Math.min(count - 1, idx));
    const label = labels[idx] || `#${idx + 1}`;
    tipTitle.textContent = String(label);
    series.forEach((s, si) => {
      const v = s.values[idx];
      tipLines[si].textContent = `${s.name || `Series ${si + 1}`}: ${Number.isFinite(Number(v)) ? niceNumber(Number(v), 1) : "—"}${o.unit ? ` ${o.unit}` : ""}`;
    });
    const tx = Math.min(Math.max(m.left, xAt(idx) + 8), w - tipWidth - 4);
    const ty = Math.max(4, m.top + 4);
    tip.setAttribute("transform", `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
    tip.setAttribute("visibility", "visible");
  };
  const onLeave = () => tip.setAttribute("visibility", "hidden");
  overlay.addEventListener("pointermove", onMove);
  overlay.addEventListener("pointerdown", onMove);
  overlay.addEventListener("pointerleave", onLeave);
  svg.appendChild(overlay);
  svg.appendChild(tip);

  if (o.legend && series.length) {
    const legend = svgEl("g", { class: "chart-legend-svg" });
    const per = w / series.length;
    series.forEach((s, idx) => {
      const lx = idx * per + 6;
      const ly = h - 4;
      legend.appendChild(svgEl("rect", { class: `series-${idx % 6} chart-legend-swatch`, x: lx, y: ly - 7, width: 9, height: 3, rx: 1 }));
      legend.appendChild(svgEl("text", { class: "chart-axis", x: lx + 13, y: ly }, s.name || `Series ${idx + 1}`));
    });
    svg.appendChild(legend);
  }

  node.appendChild(svg);
  srSummary(node, (o.series || []).map((s) => {
    const last = Array.isArray(s.values) && s.values.length ? s.values[s.values.length - 1] : "—";
    return `${s.name || "series"}: ${last}${o.unit || ""}`;
  }).join("; "));
}

/* ---------------------------------- donut ---------------------------------- */

function drawDonut(rec, w, h) {
  const o = rec.options;
  const node = rec.node;
  const segments = (o.segments || []).filter((s) => s && Number.isFinite(Number(s.value)) && Number(s.value) > 0);
  const total = segments.reduce((sum, s) => sum + Number(s.value), 0);
  if (total <= 0) {
    emptySvg(node, w, h, "No data yet");
    return;
  }
  const legendH = segments.length ? Math.min(h * 0.45, segments.length * 17 + 6) : 0;
  const ringH = Math.max(40, h - legendH);
  const cx = w / 2;
  const cy = ringH / 2;
  const r = Math.max(18, Math.min(w, ringH) / 2 - 16);
  const circ = 2 * Math.PI * r;

  clearNode(node);
  const svg = svgEl("svg", { class: "chart-svg chart-donut", viewBox: `0 0 ${w} ${ringH}`, width: "100%", height: String(ringH) });
  svg.appendChild(svgEl("circle", { class: "chart-track", cx, cy, r, fill: "none", "stroke-width": Math.max(10, r * 0.26) }));
  let offset = 0;
  segments.forEach((s, idx) => {
    const len = (Number(s.value) / total) * circ;
    const cls = s.severity ? `chart-sev-${severityClass(s.severity)}` : `seg-${idx % 6}`;
    svg.appendChild(svgEl("circle", {
      class: `chart-donut-seg ${cls}`,
      cx, cy, r, fill: "none",
      "stroke-width": Math.max(10, r * 0.26),
      "stroke-dasharray": `${Math.max(0, len - 1.5).toFixed(2)} ${(circ - Math.max(0, len - 1.5)).toFixed(2)}`,
      "stroke-dashoffset": (-offset).toFixed(2),
      transform: `rotate(-90 ${cx} ${cy})`,
    }));
    offset += len;
  });
  if (o.centerValue !== undefined && o.centerValue !== null) {
    svg.appendChild(svgEl("text", { class: "chart-value-text", x: cx, y: cy - 2, "text-anchor": "middle", "dominant-baseline": "middle" }, String(o.centerValue)));
  }
  if (o.centerLabel) svg.appendChild(svgEl("text", { class: "chart-label", x: cx, y: cy + 16, "text-anchor": "middle" }, String(o.centerLabel)));
  node.appendChild(svg);

  if (legendH > 0) {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    for (const s of segments) {
      const cls = s.severity ? `chart-sev-${severityClass(s.severity)}` : `seg-${s._i ?? 0}`;
      legend.appendChild(elSpan(`chart-legend-dot ${cls}`, "●"));
      legend.appendChild(elSpan("chart-legend-label", s.label || "Item"));
      legend.appendChild(elSpan("chart-legend-value", String(s.value)));
    }
    node.appendChild(legend);
  }
  srSummary(node, segments.map((s) => `${s.label || "item"}: ${s.value}`).join("; "));
}

function elSpan(cls, text) {
  const e = document.createElement("span");
  e.className = cls;
  e.textContent = text;
  return e;
}

/* ----------------------------------- bars ---------------------------------- */

function drawBarsChart(rec, w, h) {
  const o = rec.options;
  const node = rec.node;
  const items = (o.items || []).filter(Boolean);
  if (items.length === 0) {
    emptySvg(node, w, h, "No data yet");
    return;
  }
  const rowH = Math.min(30, Math.max(18, h / items.length));
  const labelW = Math.min(150, Math.max(60, w * 0.38));
  const valueW = 62;
  const trackX = labelW + 6;
  const trackW = Math.max(10, w - trackX - valueW);
  const max = Number.isFinite(Number(o.max)) && Number(o.max) > 0 ? Number(o.max) : Math.max(1, ...items.map((i) => Number(i.value) || 0));

  clearNode(node);
  const svg = svgEl("svg", { class: "chart-svg chart-bars", viewBox: `0 0 ${w} ${h}`, width: "100%", height: "100%", role: "img" });
  items.forEach((item, idx) => {
    const y = idx * rowH;
    const mid = y + rowH / 2;
    const value = Number(item.value);
    const ratio = Number.isFinite(value) ? Math.max(0, Math.min(1, value / max)) : 0;
    const severity = item.severity || sevOf(value, o.thresholds, true);
    svg.appendChild(svgEl("text", { class: "chart-bar-label", x: 0, y: mid + 3, "dominant-baseline": "middle" }, String(item.label || `#${idx + 1}`)));
    svg.appendChild(svgEl("rect", { class: "chart-bar-track", x: trackX, y: mid - 5, width: trackW, height: 10, rx: 5 }));
    svg.appendChild(svgEl("rect", { class: `chart-bar-fill chart-sev-${severityClass(severity)}`, x: trackX, y: mid - 5, width: Math.max(0, ratio * trackW).toFixed(1), height: 10, rx: 5 }));
    svg.appendChild(svgEl("text", { class: "chart-bar-value", x: w - 2, y: mid + 3, "text-anchor": "end", "dominant-baseline": "middle" }, item.display !== undefined ? String(item.display) : `${Math.round(value)}${o.unit || ""}`));
  });
  node.appendChild(svg);
  srSummary(node, items.map((i) => `${i.label || "item"}: ${i.display !== undefined ? i.display : i.value}${o.unit || ""}`).join("; "));
}

/* -------------------------------- sparkline -------------------------------- */

function drawSpark(rec, w, h) {
  const o = rec.options;
  const node = rec.node;
  const values = (o.values || []).filter((v) => Number.isFinite(Number(v))).map(Number);
  if (values.length < 2) {
    emptySvg(node, w, h, "Collecting…");
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;
  const pts = values.map((v, i) => `${i === 0 ? "M" : "L"} ${(pad + (i / (values.length - 1)) * (w - pad * 2)).toFixed(1)},${(h - pad - ((v - min) / range) * (h - pad * 2)).toFixed(1)}`);
  clearNode(node);
  const svg = svgEl("svg", { class: "chart-svg chart-spark", viewBox: `0 0 ${w} ${h}`, width: "100%", height: "100%", role: "img" });
  if (o.fill) {
    svg.appendChild(svgEl("path", { class: `chart-area ${o.color ? `area-${o.color}` : "area-0"}`, d: `${pts.join(" ")} L ${(w - pad).toFixed(1)},${h} L ${pad},${h} Z` }));
  }
  svg.appendChild(svgEl("path", { class: `chart-line ${o.color !== undefined ? `series-${o.color}` : "series-0"}`, d: pts.join(" "), fill: "none" }));
  node.appendChild(svg);
  srSummary(node, `Trend from ${Math.round(values[0])} to ${Math.round(values[values.length - 1])}`);
}

/* ------------------------------- chain strip -------------------------------- */

function drawChainStrip(rec, w, h) {
  const o = rec.options;
  const node = rec.node;
  const items = o.items || [];
  if (items.length === 0) {
    emptySvg(node, w, h, "No chain data yet");
    return;
  }
  const gap = 3;
  const segW = Math.max(4, (w - gap * (items.length - 1)) / items.length);
  const barH = Math.min(26, h * 0.5);
  const y = (h - barH) / 2;
  clearNode(node);
  const svg = svgEl("svg", { class: "chart-svg chart-chain", viewBox: `0 0 ${w} ${h}`, width: "100%", height: "100%", role: "img" });
  items.forEach((item, idx) => {
    const raw = typeof item === "object" && item !== null ? (item.status ?? item.severity) : item;
    const sev = raw === true || raw === "ok" ? "ok" : raw === false ? "critical" : severityClass(raw || "info");
    svg.appendChild(svgEl("rect", {
      class: `chart-chain-seg chart-sev-${sev}`,
      x: idx * (segW + gap), y, width: segW, height: barH, rx: 2,
    }));
  });
  node.appendChild(svg);
  srSummary(node, `${items.length} recent chain entries, overall ${o.status || "unknown"}`);
}

/* ------------------------------- per-core bars ------------------------------ */

function drawPerCore(rec, w, h) {
  const o = rec.options;
  const node = rec.node;
  const values = (o.values || []).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  if (values.length === 0) {
    emptySvg(node, w, h, "No per-core data");
    return;
  }
  const gap = 4;
  const barW = Math.max(4, (w - gap * (values.length - 1)) / values.length);
  const labelH = 14;
  const barH = Math.max(10, h - labelH - 6);
  const top = 2;
  const thresholds = o.thresholds || DEFAULT_THRESHOLDS;
  clearNode(node);
  const svg = svgEl("svg", { class: "chart-svg chart-cores", viewBox: `0 0 ${w} ${h}`, width: "100%", height: "100%", role: "img" });
  values.forEach((v, idx) => {
    const ratio = Math.max(0, Math.min(1, v / 100));
    const sev = sevOf(v, thresholds, false);
    const x = idx * (barW + gap);
    svg.appendChild(svgEl("rect", { class: "chart-bar-track", x, y: top, width: barW, height: barH, rx: 3 }));
    const fillH = Math.max(1, ratio * barH);
    svg.appendChild(svgEl("rect", { class: `chart-bar-fill chart-sev-${sev}`, x, y: top + barH - fillH, width: barW, height: fillH.toFixed(1), rx: 3 }));
    svg.appendChild(svgEl("text", { class: "chart-axis", x: x + barW / 2, y: h - 2, "text-anchor": "middle" }, String(idx + 1)));
  });
  node.appendChild(svg);
  srSummary(node, `CPU per core: ${values.map((v) => `${Math.round(v)}%`).join(", ")}`);
}

/* ------------------------------- registration ------------------------------- */

const DRAWERS = {
  gauge: drawGauge,
  line: drawLineChart,
  donut: drawDonut,
  bars: drawBarsChart,
  spark: drawSpark,
  chain: drawChainStrip,
  cores: drawPerCore,
};

function ensureInfrastructure() {
  if (!themeBound && typeof window !== "undefined") {
    window.addEventListener("dbhub:themechange", redrawAll);
    themeBound = true;
  }
  if (!resizeBound && typeof window !== "undefined") {
    window.addEventListener("resize", redrawAll);
    resizeBound = true;
  }
  if (!observer && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rec = instances.get(entry.target);
        if (rec) draw(rec);
      }
    });
  }
}

function draw(rec) {
  if (!rec || !rec.node || !rec.node.isConnected) return;
  const fallbackH = rec.type === "gauge" ? 150 : rec.type === "spark" ? 44 : 160;
  const { w, h } = measure(rec.node, 300, fallbackH);
  const fn = DRAWERS[rec.type];
  if (!fn) return;
  try {
    fn(rec, w, h);
  } catch (e) {
    // Charts must never crash the dashboard.
    emptySvg(rec.node, w, h, "Chart unavailable");
  }
}

function register(node, type, options, fallbackH, ariaLabel) {
  if (!node) return node;
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  const rec = { node, type, options: options || {} };
  instances.set(node, rec);
  ensureInfrastructure();
  if (observer) observer.observe(node);
  draw(rec);
  return node;
}

export function gauge(node, options) {
  return register(node, "gauge", options, 150, `${options?.label || "Gauge"} gauge`);
}

export function lineChart(node, options) {
  return register(node, "line", options, 160, options?.ariaLabel || "Line chart");
}

export function donut(node, options) {
  return register(node, "donut", options, 170, options?.ariaLabel || "Donut chart");
}

export function bars(node, options) {
  return register(node, "bars", options, Math.max(60, (options?.items || []).length * 26), options?.ariaLabel || "Bar chart");
}

export function sparkline(node, values, options = {}) {
  return register(node, "spark", { values, ...options }, 44, options.ariaLabel || "Trend sparkline");
}

export function chainStrip(node, options) {
  return register(node, "chain", options, 60, options?.ariaLabel || "Chain status strip");
}

export function perCoreBars(node, options) {
  return register(node, "cores", options, 90, options?.ariaLabel || "Per-core CPU bars");
}

export function redrawAll() {
  for (const rec of instances.values()) draw(rec);
}

export function dispose(node) {
  if (!node) return;
  if (observer) observer.unobserve(node);
  instances.delete(node);
}

export function disposeAll() {
  if (observer) {
    try { observer.disconnect(); } catch (e) { /* ignore */ }
    observer = null;
  }
  instances.clear();
}

// Backwards-compatible aliases for the old canvas API.
export function drawSparkline(node, values, color) {
  return sparkline(node, values, { color: typeof color === "number" ? color : 0 });
}
export function drawBars(node, values, color) {
  return bars(node, { items: (values || []).map((v) => ({ value: v })), max: Math.max(1, ...(values || [])) });
}

// Re-exported for convenience so views can derive a severity from a value.
export { percentSeverity };

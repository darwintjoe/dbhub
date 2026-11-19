// Shared building blocks for admin views. Pure DOM, no inline styles.

import { el, card, badge, emptyState, stat } from "../lib/dom.js";
import { iconForSeverity, severityClass, labelForSeverity } from "../lib/status.js";

export function pageTitle(title, subtitle) {
  const head = el("div", { class: "section-header" }, [el("h2", { text: title })]);
  if (subtitle) head.appendChild(el("p", { class: "muted", text: subtitle }));
  return head;
}

/**
 * chartCard(title, kind, options) -> { card, body }
 * kind: "gauge" | "chart" | "tall" | "spark" | "auto"
 */
export function chartCard(title, kind = "chart", options = {}) {
  const cls = kind === "gauge" ? "gauge-box"
    : kind === "spark" ? "spark-box"
      : kind === "tall" ? "chart-box tall"
        : kind === "auto" ? "" : "chart-box";
  const body = el("div", { class: cls });
  const footer = el("div", { class: "chart-card-footer" });
  const children = [body];
  if (options.footer) children.push(footer);
  const c = card({ title, subtitle: options.subtitle, severity: options.severity, extra: options.extra }, children);
  return { card: c, body, footer };
}

export function kv(label, valueNode) {
  return el("div", { class: "row" }, [
    el("span", { class: "muted grow", text: label }),
    valueNode instanceof Node ? valueNode : el("span", { text: valueNode == null ? "—" : String(valueNode) }),
  ]);
}

export function alertsList(alerts) {
  const list = el("div", { class: "alert-list" });
  const items = Array.isArray(alerts) ? alerts : [];
  if (items.length === 0) {
    list.appendChild(el("div", { class: "alert alert-ok" }, [
      el("span", { class: "alert-icon", text: iconForSeverity("ok"), "aria-hidden": "true" }),
      el("span", { class: "alert-text", text: "No alerts. Everything looks normal." }),
    ]));
    return list;
  }
  const order = { critical: 0, warning: 1, info: 2, ok: 3 };
  for (const a of [...items].sort((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9))) {
    const sev = severityClass(a.severity);
    list.appendChild(el("div", { class: `alert alert-${sev}` }, [
      el("span", { class: "alert-icon", text: iconForSeverity(sev), "aria-hidden": "true" }),
      el("span", { class: "alert-text" }, [
        el("div", { text: a.text || a.message || "Issue detected" }),
        a.code ? el("div", { class: "alert-code", text: a.code }) : null,
      ]),
    ]));
  }
  return list;
}

export function scoreRing(score) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "score-ring");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Data Safety Score ${score} out of 100`);
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const sev = score >= 90 ? "ok" : score >= 70 ? "info" : score >= 40 ? "warning" : "critical";
  const r = 19;
  const circ = 2 * Math.PI * r;
  svg.appendChild(mk("circle", { cx: 24, cy: 24, r, class: "chart-track", fill: "none", "stroke-width": 5 }));
  svg.appendChild(mk("circle", {
    cx: 24, cy: 24, r, fill: "none", "stroke-width": 5,
    class: `chart-sev-${sev}`,
    "stroke-dasharray": `${((score / 100) * circ).toFixed(1)} ${circ.toFixed(1)}`,
    transform: "rotate(-90 24 24)",
  }));
  svg.appendChild(mk("text", { x: 24, y: 27, "text-anchor": "middle", class: "chart-value-text" }, String(score)));
  return svg;
}

export function breakdownChips(breakdown) {
  const wrap = el("div", { class: "breakdown" });
  for (const b of breakdown || []) {
    const sev = severityClass(b.severity);
    const label = `${iconForSeverity(sev)} ${b.label} ${b.points > 0 ? "+" : ""}${b.points}`;
    wrap.appendChild(el("span", { class: `breakdown-chip chip-${sev}`, title: b.detail || "" }, [el("span", { text: label })]));
  }
  return wrap;
}

export function statusBadge(label, severity) {
  return badge(label, severity);
}

export function emptyOr(node, message) {
  return node || emptyState(message);
}

export function statRow(items) {
  const row = el("div", { class: "kpi-grid" });
  for (const item of items) row.appendChild(stat(item.label, item.value, item));
  return row;
}

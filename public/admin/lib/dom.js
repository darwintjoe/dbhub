// Safe DOM helpers. Never writes untrusted values through innerHTML.
// All text is assigned via textContent / text nodes.

import { iconForSeverity, labelForSeverity, severityClass } from "./status.js";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = String(dv);
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      node.appendChild(child);
    }
  }
  return node;
}

export function setText(node, value) {
  if (!node) return;
  const next = value === null || value === undefined ? "—" : String(value);
  if (node.textContent !== next) node.textContent = next;
}

export function badge(label, severity = "info") {
  const sev = severityClass(severity);
  return el("span", { class: `badge badge-${sev}` }, [
    el("span", { class: "badge-icon", text: iconForSeverity(sev), "aria-hidden": "true" }),
    el("span", { text: label == null ? labelForSeverity(sev) : String(label) }),
  ]);
}

export function emptyState(message = "No data yet") {
  return el("div", { class: "empty" }, [
    el("span", { class: "empty-icon", text: "○", "aria-hidden": "true" }),
    el("span", { text: message }),
  ]);
}

export function section(title, subtitle) {
  const head = el("div", { class: "section-header" }, [
    el("h2", { text: title }),
  ]);
  if (subtitle) head.appendChild(el("p", { class: "muted", text: subtitle }));
  return head;
}

/**
 * card({ title, subtitle, severity, extra, className }, children)
 */
export function card(options = {}, children = []) {
  const opts = typeof options === "string" ? { title: options } : options;
  const cls = ["card", opts.className].filter(Boolean).join(" ");
  const node = el("section", { class: cls });
  if (opts.title || opts.subtitle || opts.severity || opts.extra) {
    const head = el("div", { class: "card-header" });
    if (opts.title) head.appendChild(el("h3", { text: opts.title }));
    if (opts.subtitle) head.appendChild(el("p", { class: "muted", text: opts.subtitle }));
    if (opts.severity) head.appendChild(badge(labelForSeverity(opts.severity), opts.severity));
    if (opts.extra instanceof Node) head.appendChild(opts.extra);
    node.appendChild(head);
  }
  const body = el("div", { class: "card-body" });
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    body.appendChild(child instanceof Node ? child : el("span", { text: String(child) }));
  }
  node.appendChild(body);
  return node;
}

export function stat(label, value, options = {}) {
  const sev = options.severity ? severityClass(options.severity) : null;
  const node = el("div", { class: ["stat", sev ? `stat-${sev}` : ""].filter(Boolean).join(" ") }, [
    el("div", { class: "stat-label", text: label }),
    el("div", { class: "stat-value", text: value == null ? "—" : String(value) }),
  ]);
  if (options.hint) node.appendChild(el("div", { class: "stat-hint muted", text: options.hint }));
  return node;
}

/**
 * Responsive table. Below 720px rows render as stacked cards using data-label.
 * columns: [{ key, label, render?(row) => Node|string }]
 */
export function dataTable(columns, rows, options = {}) {
  const table = el("table", { class: "data-table" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of columns) headRow.appendChild(el("th", { scope: "col", text: col.label }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    const tr = el("tr");
    const td = el("td", { colspan: String(columns.length) });
    td.appendChild(emptyState(options.emptyMessage || "No data yet"));
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const row of list) {
      const tr = el("tr");
      for (const col of columns) {
        const td = el("td", { "data-label": col.label });
        const content = typeof col.render === "function" ? col.render(row) : row[col.key];
        if (content instanceof Node) td.appendChild(content);
        else td.textContent = content === null || content === undefined ? "—" : String(content);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  const wrap = el("div", { class: "table-wrap" }, [table]);
  return wrap;
}

let toastStack = null;
export function toast(message, severity = "info", timeout = 4500) {
  if (!toastStack) {
    toastStack = el("div", { class: "toast-stack", "aria-live": "polite" });
    document.body.appendChild(toastStack);
  }
  const sev = severityClass(severity);
  const node = el("div", { class: `toast toast-${sev}`, role: "status" }, [
    el("span", { class: "toast-icon", text: iconForSeverity(sev), "aria-hidden": "true" }),
    el("span", { text: String(message) }),
  ]);
  toastStack.appendChild(node);
  if (timeout > 0) setTimeout(() => node.remove(), timeout);
  return node;
}

export function copyButton(getValue, label = "Copy") {
  const btn = el("button", { type: "button", class: "btn btn-ghost", text: label });
  btn.addEventListener("click", async () => {
    try {
      const value = await getValue();
      if (value === null || value === undefined) return;
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(String(value));
      toast("Copied to clipboard", "ok");
    } catch (e) {
      toast("Could not copy", "warning");
    }
  });
  return btn;
}

export function actionButton(label, handler, options = {}) {
  const btn = el("button", {
    type: "button",
    class: ["btn", options.primary ? "btn-primary" : "btn-ghost", options.danger ? "btn-danger" : ""].filter(Boolean).join(" "),
    text: label,
  });
  btn.addEventListener("click", handler);
  return btn;
}

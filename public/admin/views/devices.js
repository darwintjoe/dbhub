import { el, card, badge, dataTable, actionButton, copyButton, emptyState, toast, stat } from "../lib/dom.js";
import { deviceSeverity, labelForSeverity, severityClass, percentSeverity } from "../lib/status.js";
import { formatNumber, timeAgo } from "../lib/format.js";
import { pageTitle, kv } from "./common.js";

function tokenModal(title, text) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
  modal.append(
    el("h3", { text: title }),
    el("p", { class: "muted", text: "Shown once. Store it securely before closing." }),
    el("div", { class: "token-box", text: text }),
  );
  const actions = el("div", { class: "row" });
  actions.append(
    copyButton(() => text, "Copy"),
    actionButton("Close", () => backdrop.remove()),
  );
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

export function mountDevices(main, ctx) {
  const { api, charts } = ctx;

  main.appendChild(pageTitle("Devices", "Registered devices, sync health and roles"));

  const quick = el("div", { class: "kpi-grid" });
  main.appendChild(quick);

  const toolbar = el("div", { class: "row" });
  const createBtn = actionButton("Create device", () => showCreate(), { primary: true });
  const refreshBtn = actionButton("Refresh", () => load());
  toolbar.append(createBtn, refreshBtn);
  main.appendChild(toolbar);

  const loadBox = el("div", { class: "chart-box" });
  const loadCard = card({
    title: ctx.isDemo ? "Recent device load" : "Recent device activity",
    subtitle: ctx.isDemo ? "Latest bundle activity per device" : "Accepted bundles per device (last 5 minutes)",
  }, [loadBox]);
  main.appendChild(loadCard);

  const tableHost = el("div");
  main.appendChild(tableHost);

  let devices = [];

  function showCreate() {
    const backdrop = el("div", { class: "modal-backdrop" });
    const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
    const labelField = el("div", { class: "field" }, [el("label", { text: "Label" }), el("input", { type: "text", value: "Device", placeholder: "e.g. KASIR-1" })]);
    const prefixField = el("div", { class: "field" }, [el("label", { text: "Prefix (optional)" }), el("input", { type: "text", placeholder: "e.g. KASIR1" })]);
    const roleNote = el("p", { class: "muted", text: "New devices are working nodes. Full replica promotion is not implemented yet." });
    const err = el("div", { class: "muted" });
    const submit = actionButton("Create", async () => {
      const label = labelField.querySelector("input").value.trim() || "Device";
      const prefix = prefixField.querySelector("input").value.trim();
      try {
        const body = { label, role: "device" };
        if (prefix) body.prefix = prefix;
        const res = await api("/api/v1/admin/devices", { method: "POST", body: JSON.stringify(body) });
        backdrop.remove();
        toast("Device created", "ok");
        if (res && res.tokenShown === false) toast("Demo: token not shown", "info");
        else if (res && res.token) tokenModal("New device token", res.token);
        load();
      } catch (e) { err.textContent = e.message; }
    }, { primary: true });
    modal.append(el("h3", { text: "Create device" }), labelField, prefixField, roleNote, err,
      el("div", { class: "row" }, [submit, actionButton("Cancel", () => backdrop.remove())]));
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
  }

  async function load() {
    try {
      const data = await api("/api/v1/admin/devices");
      devices = Array.isArray(data.devices) ? data.devices : [];
      renderTable();
      if (lastSample) drawLoad(lastSample);
    } catch (e) { ctx.showError(e.message); }
  }

  function statusCell(d) {
    const sev = d.online ? "ok" : deviceSeverity(d.lastSeenAt);
    return el("span", { class: "row" }, [
      el("span", { class: `dot dot-${severityClass(sev)}` }),
      el("span", { text: d.online ? "Online" : "Offline" }),
    ]);
  }

  function renderTable() {
    const rows = devices.map((d) => ({
      label: el("div", {}, [
        el("strong", { text: d.label || d.prefix || d.id }),
        el("div", { class: "muted", text: d.id }),
      ]),
      prefix: el("span", { class: "pill", text: d.prefix || "—" }),
      status: statusCell(d),
      seen: timeAgo(d.lastSeenAt),
      version: d.appVersion || "unknown",
      counts: el("div", { class: "row" }, [
        el("span", { class: "pill", text: `A ${formatNumber(d.accepted)}` }),
        el("span", { class: "pill", text: `P ${formatNumber(d.pending)}` }),
        el("span", { class: "pill", text: `Q ${formatNumber(d.quarantined)}` }),
      ]),
      role: badge(d.role || "Working node", /full replica/i.test(d.role || "") ? "info" : "ok"),
      actions: el("div", { class: "row" }, [
        actionButton("Rotate token", async () => {
          if (!confirm(`Rotate token for ${d.label || d.id}?`)) return;
          try {
            const r = await api(`/api/v1/admin/devices/${encodeURIComponent(d.id)}/rotate-token`, { method: "POST" });
            if (r && r.tokenShown === false) toast("Demo: token not shown", "info");
            else if (r && r.token) tokenModal("Rotated device token", r.token);
            else toast("Token rotated", "ok");
          } catch (e) { toast(e.message, "warning"); }
        }),
        actionButton("Revoke", async () => {
          if (!confirm(`Revoke ${d.label || d.id}? This blocks sync immediately.`)) return;
          try {
            await api(`/api/v1/admin/devices/${encodeURIComponent(d.id)}/revoke`, { method: "POST" });
            toast("Device revoked", "warning");
            load();
          } catch (e) { toast(e.message, "warning"); }
        }, { danger: true }),
      ]),
    }));
    tableHost.replaceChildren(card({ title: "Registered devices", subtitle: `${devices.length} device(s)` }, [
      dataTable([
        { key: "label", label: "Device" },
        { key: "prefix", label: "Prefix" },
        { key: "status", label: "Status" },
        { key: "seen", label: "Last seen" },
        { key: "version", label: "App version" },
        { key: "counts", label: "A / P / Q" },
        { key: "role", label: "Role" },
        { key: "actions", label: "Actions" },
      ], rows, { emptyMessage: "No devices registered yet" }),
    ]));
  }

  function drawLoad(sample) {
    const list = devices.length ? devices : (Array.isArray(sample.devices) ? sample.devices : []);
    const items = list.map((d) => {
      const hasLoad = Array.isArray(d.recentLoad) && d.recentLoad.length > 0;
      const raw = hasLoad ? d.recentLoad.slice(-1)[0] : d.recentAccepted;
      const value = Math.max(0, Number(raw) || 0);
      return {
        label: d.label || d.prefix || d.id,
        value,
        display: ctx.isDemo && hasLoad ? `${Math.round(value)}%` : String(Math.round(value)),
        // Live values are accepted-bundle counts, not CPU percentages.
        severity: ctx.isDemo && hasLoad ? percentSeverity("cpu", value) : "info",
      };
    });
    charts.bars(loadBox, {
      items,
      max: ctx.isDemo ? 100 : Math.max(1, ...items.map((i) => i.value)),
      unit: ctx.isDemo ? "%" : "bundles",
      thresholds: ctx.isDemo ? ctx.status.THRESHOLDS.cpu : undefined,
    });
  }

  let lastSample = null;
  const firstSample = ctx.lastSample;
  if (firstSample) {
    lastSample = firstSample;
    const list = Array.isArray(firstSample.devices) && firstSample.devices.length
      ? firstSample.devices.map((d) => ({ ...d }))
      : [];
    if (list.length) { devices = list; renderTable(); drawLoad(firstSample); }
  }

  function render(sample) {
    if (!sample) return;
    lastSample = sample;
    const summary = Array.isArray(sample.devices) ? sample.devices : devices;
    const online = summary.filter((d) => d.online === true).length;
    quick.replaceChildren(
      stat("Total devices", String(summary.length || sample.counts?.devices || 0)),
      stat("Online", String(online), { severity: online === summary.length ? "ok" : "warning" }),
      stat("Pending", formatNumber(sample.counts?.pendingParent)),
      stat("To review", formatNumber(sample.counts?.quarantined), { severity: Number(sample.counts?.quarantined) > 0 ? "warning" : "ok" }),
    );
    if (!devices.length && summary.length) { devices = summary.map((d) => ({ ...d })); renderTable(); }
    drawLoad(sample);
  }

  load();
  return render;
}

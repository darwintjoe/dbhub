import { el, card, badge, dataTable, actionButton, emptyState, toast } from "../lib/dom.js";
import { plainLabel, severityClass } from "../lib/status.js";
import { formatNumber, timeAgo } from "../lib/format.js";
import { pageTitle, kv } from "./common.js";

const REASONS = ["duplicate_event", "missing_parent", "hash_mismatch", "schema_incompatibility", "revoked_device"];

function detailModal(item) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
  modal.append(
    el("h3", { text: "Quarantine detail" }),
    el("p", { class: "muted", text: "Payload content is never displayed here." }),
  );
  const lines = el("div", { class: "stack" });
  lines.append(
    kv("Bundle", item.bundleId),
    kv("Device", item.deviceId),
    kv("Reason", plainLabel(item.reason)),
    kv("Status", item.status),
    kv("Received", timeAgo(item.receivedAt)),
    kv("Hub sequence", formatNumber(item.hubSeq)),
  );
  if (item.note) lines.appendChild(el("p", { class: "muted", text: item.note }));
  modal.append(lines, el("div", { class: "row" }, [actionButton("Close", () => backdrop.remove())]));
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

export function mountQuarantine(main, ctx) {
  const { api, charts } = ctx;

  main.appendChild(pageTitle("Quarantine", "Items that need review — payloads stay hidden in lists"));

  const toolbar = el("div", { class: "row" });
  const reasonSel = el("select", { "aria-label": "Filter by reason" });
  reasonSel.append(el("option", { value: "", text: "All reasons" }));
  for (const r of REASONS) reasonSel.appendChild(el("option", { value: r, text: plainLabel(r) }));
  const deviceInput = el("input", { type: "search", placeholder: "Device ID", "aria-label": "Device ID" });
  const refreshBtn = actionButton("Refresh", () => load());
  toolbar.append(reasonSel, deviceInput, refreshBtn);
  main.appendChild(toolbar);

  const summary = el("div", { class: "two-col" });
  const donutCard = card({ title: "By reason", subtitle: "Distribution of quarantined items" });
  const donutBox = el("div", { class: "gauge-box" });
  donutCard.querySelector(".card-body").appendChild(donutBox);
  const infoCard = card({ title: "What this means", subtitle: "Plain-language reasons" });
  const infoBody = el("div", { class: "stack" });
  infoCard.querySelector(".card-body").appendChild(infoBody);
  summary.append(donutCard, infoCard);
  main.appendChild(summary);

  const tableHost = el("div");
  main.appendChild(tableHost);

  let items = [];

  async function load() {
    try {
      const q = new URLSearchParams({ limit: "200" });
      if (reasonSel.value) q.set("reason", reasonSel.value);
      if (deviceInput.value.trim()) q.set("deviceId", deviceInput.value.trim());
      const data = await api("/api/v1/admin/quarantine?" + q.toString());
      items = Array.isArray(data.items) ? data.items : [];
      render();
    } catch (e) { ctx.showError(e.message); }
  }

  function render() {
    const counts = {};
    for (const it of items) {
      const key = it.reason || "unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
    charts.donut(donutBox, {
      segments: Object.keys(counts).map((key, i) => ({
        value: counts[key], label: plainLabel(key), severity: i === 0 ? "warning" : i === 1 ? "info" : "ok",
      })),
      centerValue: String(items.length),
      centerLabel: "to review",
    });
    infoBody.replaceChildren(
      ...Object.keys(counts).map((key) => kv(plainLabel(key), String(counts[key]))),
      el("p", { class: "muted", text: "Items are kept, not deleted. Fix the underlying data before retrying." }),
    );

    const rows = items.map((it) => ({
      bundle: el("span", { text: it.bundleId || "—" }),
      device: it.deviceId || "—",
      reason: badge(plainLabel(it.reason), "warning"),
      status: it.status || "quarantined",
      received: timeAgo(it.receivedAt),
      actions: actionButton("View detail", async () => {
        try {
          const detail = await api("/api/v1/admin/quarantine/" + encodeURIComponent(it.bundleId));
          detailModal(detail && detail.bundleId ? detail : it);
        } catch (e) { toast(e.message, "warning"); }
      }),
    }));
    tableHost.replaceChildren(card({ title: "Quarantined items", subtitle: `${items.length} item(s)` }, [
      dataTable([
        { key: "bundle", label: "Bundle" },
        { key: "device", label: "Device" },
        { key: "reason", label: "Reason" },
        { key: "status", label: "Status" },
        { key: "received", label: "Received" },
        { key: "actions", label: "Detail" },
      ], rows, { emptyMessage: "Nothing in quarantine" }),
    ]));
  }

  reasonSel.addEventListener("change", load);
  deviceInput.addEventListener("change", load);
  load();
  return () => {};
}

import { el, card, badge, actionButton, copyButton, emptyState, toast } from "../lib/dom.js";
import { tunnelSeverity, nicUtilization, networkSeverity, labelForSeverity, severityClass } from "../lib/status.js";
import { formatRate, formatPercent, timeAgo } from "../lib/format.js";
import { pageTitle, chartCard, kv, statRow } from "./common.js";

export function mountNetwork(main, ctx) {
  const { api, charts } = ctx;

  main.appendChild(pageTitle("Network", "Local discovery, adapters and remote tunnel"));

  const row1 = el("div", { class: "two-col" });
  main.appendChild(row1);
  const lanCard = card({ title: "LAN & discovery", subtitle: "Local admin access" });
  const lanBody = el("div", { class: "stack" });
  lanCard.querySelector(".card-body").appendChild(lanBody);
  const tunnelCard = card({ title: "Remote access / tunnel", subtitle: "Cloudflare Tunnel status" });
  const tunnelBody = el("div", { class: "stack" });
  tunnelCard.querySelector(".card-body").appendChild(tunnelBody);
  row1.append(lanCard, tunnelCard);

  const nicChart = chartCard("Adapter traffic", "tall", { subtitle: "Bytes per second per adapter", footer: true });
  main.appendChild(nicChart.card);
  const utilCard = card({ title: "Adapter utilisation", subtitle: "Compared with link speed" });
  const utilGrid = el("div", { class: "kpi-grid" });
  utilCard.querySelector(".card-body").appendChild(utilGrid);
  main.appendChild(utilCard);

  const warn = el("div", { class: "banner", text: "Admin UI is never reachable through the public hostname — only data routes are exposed remotely." });
  main.appendChild(warn);

  const live = el("div", { class: "muted", "aria-live": "polite" });
  main.appendChild(live);

  let diagnostics = null;
  let connectivity = null;

  async function load() {
    try {
      diagnostics = await api("/api/v1/admin/diagnostics");
      connectivity = await api("/api/v1/admin/connectivity");
      renderMeta();
    } catch (e) { ctx.showError(e.message); }
  }

  function renderMeta() {
    const diag = diagnostics || {};
    const conn = connectivity || {};
    const tunnel = conn.tunnel || {};
    const sev = tunnelSeverity(tunnel);

    lanBody.replaceChildren(
      ...(Array.isArray(diag.lanIps) && diag.lanIps.length
        ? diag.lanIps.map((ip) => kv("LAN address", el("span", { class: "row" }, [el("span", { text: ip }), copyButton(() => ip)])))
        : [kv("LAN address", "none detected")]),
      kv("mDNS hostname", diag.hostname ? `${diag.hostname}.local` : "—"),
      kv("Admin port", String(diag.adminPort ?? "—")),
      kv("Hub serial", diag.serial || "—"),
    );

    tunnelBody.replaceChildren(
      kv("Status", badge(labelForSeverity(sev) + " · " + (tunnel.status || "disabled"), sev)),
      kv("Public URL", conn.publicUrl || "not configured"),
      kv("Last error", tunnel.lastError || "none"),
      kv("Restarts", String(tunnel.restartCount ?? 0)),
      kv("Last started", timeAgo(tunnel.lastStartAt)),
      kv("PID", tunnel.pid === null || tunnel.pid === undefined ? "—" : String(tunnel.pid)),
      el("div", { class: "row" }, [
        actionButton("Restart tunnel", async () => {
          try {
            live.textContent = "Restarting tunnel…";
            await api("/api/v1/admin/connectivity/restart", { method: "POST" });
            toast("Tunnel restart requested", "ok");
            await load();
          } catch (e) { toast(e.message, "warning"); }
        }, { primary: true }),
        actionButton("Test connection", async () => {
          try {
            live.textContent = "Testing…";
            const r = await api("/api/v1/admin/connectivity/test", { method: "POST" });
            live.textContent = r && r.ok !== false ? "Connection test passed (or simulated)" : "Connection test failed";
            toast(live.textContent, r && r.ok !== false ? "ok" : "warning");
          } catch (e) { live.textContent = e.message; }
        }),
      ]),
    );

    if (tunnel.status === "not_installed") {
      tunnelBody.appendChild(el("p", { class: "alert alert-warning", text: `cloudflared was not found at ${(conn.cloudflare && conn.cloudflare.binaryPath) || "the configured path"}. Install it and set connectivity.cloudflare.binaryPath.` }));
    }
  }

  function render(sample) {
    if (!sample) return;
    const nics = Array.isArray(sample.network) ? sample.network : [];
    const h = sample.history || ctx.history || {};
    // Live history stores totals; per-NIC gauges show current values and link speed.
    charts.lineChart(nicChart.body, {
      series: [
        { name: "Total received", values: h.networkRx || [], fill: true },
        { name: "Total sent", values: h.networkTx || [], fill: true },
      ],
      unit: "B/s", legend: true, timeLabels: h.timeLabels || [],
    });
    nicChart.footer.replaceChildren(
      el("span", { text: `↓ ${formatRate(sample.rates?.rxBytesPerSec)}` }),
      el("span", { text: `↑ ${formatRate(sample.rates?.txBytesPerSec)}` }),
      el("span", { text: `${nics.length} adapter(s)` }),
    );

    utilGrid.replaceChildren();
    nics.forEach((n) => {
      const util = nicUtilization(n);
      const sev = util === null ? "info" : networkSeverity(util);
      const c = card({ title: n.name || "Adapter", severity: sev });
      const box = el("div", { class: "gauge-box" });
      c.querySelector(".card-body").append(box, el("div", { class: "chart-card-footer" }, [
        el("span", { text: `${n.linkSpeedMbps ? n.linkSpeedMbps + " Mb/s link" : "unknown link"}` }),
        el("span", { text: `↓ ${formatRate(n.rxBytesPerSec)} ↑ ${formatRate(n.txBytesPerSec)}` }),
        el("span", { text: `${Number(n.rxErrors || 0)} errors · ${Number(n.rxDiscards || 0)} discards` }),
      ]));
      utilGrid.appendChild(c);
      charts.gauge(box, {
        value: util || 0, min: 0, max: 100, unit: "%", label: "utilised",
        unknown: util === null, thresholds: { warning: 80, critical: 95 },
      });
    });
    if (nics.length === 0) utilGrid.appendChild(emptyState("No adapter data yet"));
  }

  load();
  return render;
}

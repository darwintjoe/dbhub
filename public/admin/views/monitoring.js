import { el, card, badge, stat, dataTable, emptyState } from "../lib/dom.js";
import { percentSeverity, diskSeverity, networkSeverity, nicUtilization, labelForSeverity, severityClass } from "../lib/status.js";
import { formatBytes, formatRate, formatNumber, formatPercent, formatDuration, timeAgo } from "../lib/format.js";
import { pageTitle, chartCard, kv, statRow } from "./common.js";

export function mountMonitoring(main, ctx) {
  const { charts, status } = ctx;

  main.appendChild(pageTitle("Monitoring", "Host, process, storage and network detail"));

  const quick = el("div", { class: "kpi-grid" });
  main.appendChild(quick);

  const row1 = el("div", { class: "two-col" });
  const cpuChart = chartCard("Host CPU", "tall", { footer: true });
  const coreCard = card({ title: "Per-core CPU", subtitle: "Logical processors" });
  const coreBox = el("div", { class: "chart-box" });
  coreCard.querySelector(".card-body").appendChild(coreBox);
  row1.append(cpuChart.card, coreCard);
  main.appendChild(row1);

  const row2 = el("div", { class: "two-col" });
  const memChart = chartCard("Host memory", "chart", { footer: true });
  const procChart = chartCard("Process memory", "chart", { subtitle: "Heap and RSS", footer: true });
  row2.append(memChart.card, procChart.card);
  main.appendChild(row2);

  const row3 = el("div", { class: "two-col" });
  const nicChart = chartCard("Network traffic", "tall", { footer: true });
  const nicUtilCard = card({ title: "NIC utilisation", subtitle: "Against link speed" });
  const nicUtilBox = el("div", { class: "chart-box" });
  nicUtilCard.querySelector(".card-body").appendChild(nicUtilBox);
  row3.append(nicChart.card, nicUtilCard);
  main.appendChild(row3);

  const diskSection = el("div", { class: "section-header" }, [el("h2", { text: "Disk volumes" })]);
  main.appendChild(diskSection);
  const diskGrid = el("div", { class: "kpi-grid" });
  main.appendChild(diskGrid);
  const diskIo = chartCard("Disk I/O", "chart", { subtitle: "Read / write bytes per second", footer: true });
  main.appendChild(diskIo.card);

  const tableRow = el("div", { class: "two-col" });
  const diskTableHost = el("div");
  const nicTableHost = el("div");
  tableRow.append(diskTableHost, nicTableHost);
  main.appendChild(tableRow);

  const reqRow = el("div", { class: "two-col" });
  const reqChart = chartCard("Requests per second", "chart", { footer: true });
  const reqCard = card({ title: "Latency & errors", subtitle: "Request metrics" });
  const reqStats = el("div", { class: "stack" });
  reqCard.querySelector(".card-body").appendChild(reqStats);
  reqRow.append(reqChart.card, reqCard);
  main.appendChild(reqRow);

  const dbRow = el("div", { class: "two-col" });
  const dbCard = card({ title: "Database", subtitle: "Local replica storage" });
  const dbStats = el("div", { class: "stack" });
  dbCard.querySelector(".card-body").appendChild(dbStats);
  const svcCard = card({ title: "Process & services", subtitle: "Runtime detail" });
  const svcStats = el("div", { class: "stack" });
  svcCard.querySelector(".card-body").appendChild(svcStats);
  dbRow.append(dbCard, svcCard);
  main.appendChild(dbRow);

  function render(sample) {
    const s = sample || {};
    const h = s.history || ctx.history || {};
    const host = s.host || {};
    const proc = s.process || {};
    const disks = Array.isArray(s.disks) ? s.disks : [];
    const nics = Array.isArray(s.network) ? s.network : [];
    const db = s.db || {};
    const svc = s.service || {};
    const req = s.requests || {};

    const cpu = Number(host.cpuPercentTotal ?? proc.cpuPercent);
    const memUsed = Number(host.memoryUsedBytes);
    const memTotal = Number(host.memoryTotalBytes);
    const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : null;

    quick.replaceChildren(
      stat("Process CPU", formatPercent(proc.cpuPercent), { severity: percentSeverity("cpu", proc.cpuPercent) }),
      stat("Heap used", formatBytes(proc.heapUsedBytes)),
      stat("RSS", formatBytes(proc.rssBytes)),
      stat("Event-loop lag", `${Number(proc.eventLoopLagMs ?? 0).toFixed(1)} ms`, { severity: Number(proc.eventLoopLagMs) > 50 ? "warning" : "ok" }),
    );

    charts.lineChart(cpuChart.body, {
      series: [{ name: "CPU %", values: h.hostCpu || h.cpu || [], fill: true }],
      unit: "%", min: 0, max: 100, legend: true,
      timeLabels: h.timeLabels || [],
    });
    cpuChart.footer.replaceChildren(el("span", { text: `Now ${formatPercent(cpu)} · ${host.cpuCores || 0} cores / ${host.cpuLogical || 0} threads` }));
    charts.perCoreBars(coreBox, { values: host.cpuPercentPerCore || [], thresholds: status.THRESHOLDS.cpu });

    charts.lineChart(memChart.body, {
      series: [{ name: "Used %", values: h.hostMemUsedPercent || [], fill: true }],
      unit: "%", min: 0, max: 100, legend: true, timeLabels: h.timeLabels || [],
    });
    memChart.footer.replaceChildren(el("span", { text: `${formatBytes(memUsed)} of ${formatBytes(memTotal)}` }));
    charts.lineChart(procChart.body, {
      series: [
        { name: "Heap", values: h.processHeap || h.memory || [], fill: true },
        { name: "RSS", values: h.memory || [], fill: true },
      ],
      legend: true, timeLabels: h.timeLabels || [],
    });
    procChart.footer.replaceChildren(
      el("span", { text: `Heap ${formatBytes(proc.heapUsedBytes)} / ${formatBytes(proc.heapTotalBytes)}` }),
      el("span", { text: `RSS ${formatBytes(proc.rssBytes)}` }),
    );

    charts.lineChart(nicChart.body, {
      series: [
        { name: "Received", values: h.networkRx || [], fill: true },
        { name: "Sent", values: h.networkTx || [], fill: true },
      ],
      unit: "B/s", legend: true, timeLabels: h.timeLabels || [],
    });
    nicChart.footer.replaceChildren(
      el("span", { text: `↓ ${formatRate(s.rates?.rxBytesPerSec)}` }),
      el("span", { text: `↑ ${formatRate(s.rates?.txBytesPerSec)}` }),
    );
    charts.bars(nicUtilBox, {
      items: nics.map((n) => {
        const util = nicUtilization(n);
        return {
          label: n.name || "NIC",
          value: Number(util || 0),
          display: util === null ? "unknown" : `${Math.round(util)}%`,
          severity: util === null ? "info" : networkSeverity(util),
        };
      }),
      max: 100, unit: "%", thresholds: { warning: 80, critical: 95 },
    });

    // Disk gauges
    diskGrid.replaceChildren();
    disks.forEach((d, i) => {
      const c = card({ title: `${d.mount || "Volume"} ${d.label ? `· ${d.label}` : ""}`, severity: diskSeverity(d.usedPercent, d.freeBytes) });
      const box = el("div", { class: "gauge-box" });
      c.querySelector(".card-body").append(box, el("div", { class: "chart-card-footer" }, [
        el("span", { text: `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}` }),
      ]));
      diskGrid.appendChild(c);
      charts.gauge(box, {
        value: d.usedPercent, min: 0, max: 100, unit: "%", label: "used",
        thresholds: status.THRESHOLDS.disk,
      });
    });
    if (disks.length === 0) diskGrid.appendChild(el("div", { class: "empty", text: "No disk data available" }));

    const hasIoHistory = (h.diskRead || []).length > 0 || (h.diskWrite || []).length > 0;
    if (!ctx.isDemo && !hasIoHistory) {
      // Live samplers on some platforms have no per-volume I/O counters. Say so instead of drawing an empty chart.
      diskIo.body.replaceChildren(emptyState("Disk I/O not monitored on this platform"));
      diskIo.footer.replaceChildren(el("span", { text: "Per-volume read/write counters unavailable" }));
    } else {
      charts.lineChart(diskIo.body, {
        series: [
          { name: "Read", values: (h.diskRead || []), fill: true },
          { name: "Write", values: (h.diskWrite || []), fill: true },
        ],
        unit: "B/s", legend: true, timeLabels: h.timeLabels || [],
      });
      diskIo.footer.replaceChildren(el("span", { text: disks.map((d) => `↓ ${formatRate(d.readBytesPerSec)} ↑ ${formatRate(d.writeBytesPerSec)}`).join(" · ") || "No I/O counters" }));
    }

    const diskRows = disks.map((d) => {
      const sev = diskSeverity(d.usedPercent, d.freeBytes);
      return {
        mount: d.mount || "—",
        size: formatBytes(d.totalBytes),
        free: formatBytes(d.freeBytes),
        used: formatPercent(d.usedPercent),
        status: badge(labelForSeverity(sev), sev),
        io: `${formatRate(d.readBytesPerSec)} / ${formatRate(d.writeBytesPerSec)}`,
      };
    });
    diskTableHost.replaceChildren(card({ title: "Disk volumes" }, [
      dataTable([
        { key: "mount", label: "Volume" },
        { key: "size", label: "Size" },
        { key: "free", label: "Free" },
        { key: "used", label: "Used" },
        { key: "status", label: "Health" },
        { key: "io", label: "Read / Write" },
      ], diskRows, { emptyMessage: "No disk volumes detected" }),
    ]));

    const nicRows = nics.map((n) => {
      const util = nicUtilization(n);
      const sev = util === null ? "info" : networkSeverity(util);
      return {
        name: n.name || "—",
        speed: n.linkSpeedMbps ? `${n.linkSpeedMbps} Mb/s` : "unknown",
        traffic: `${formatRate(n.rxBytesPerSec)} / ${formatRate(n.txBytesPerSec)}`,
        util: util === null ? "unknown" : formatPercent(util),
        err: `${Number(n.rxErrors || 0)} / ${Number(n.txErrors || 0)}`,
        disc: `${Number(n.rxDiscards || 0)} / ${Number(n.txDiscards || 0)}`,
        status: badge(labelForSeverity(sev), sev),
      };
    });
    nicTableHost.replaceChildren(card({ title: "Network adapters" }, [
      dataTable([
        { key: "name", label: "Adapter" },
        { key: "speed", label: "Link" },
        { key: "traffic", label: "Rx / Tx" },
        { key: "util", label: "Utilisation" },
        { key: "err", label: "Errors (rx/tx)" },
        { key: "disc", label: "Discards" },
        { key: "status", label: "Health" },
      ], nicRows, { emptyMessage: "No network adapters detected" }),
    ]));

    const lat = req.latency || {};
    reqStats.replaceChildren(
      kv("Requests total", formatNumber(req.total)),
      kv("p50 latency", `${Number(lat.p50Ms || 0).toFixed(1)} ms`),
      kv("p95 latency", `${Number(lat.p95Ms || 0).toFixed(1)} ms`),
      kv("4xx responses", badge(formatNumber(req.status4xx), Number(req.status4xx) > 0 ? "warning" : "ok")),
      kv("5xx responses", badge(formatNumber(req.status5xx), Number(req.status5xx) > 0 ? "critical" : "ok")),
    );
    charts.lineChart(reqChart.body, {
      series: [{ name: "Requests/s", values: h.requestsPerSec || h.requests || [], fill: true }],
      legend: true, timeLabels: h.timeLabels || [],
    });
    reqChart.footer.replaceChildren(el("span", { text: `${formatNumber((h.requestsPerSec || h.requests || []).slice(-1)[0] ?? 0)} requests/s` }));

    dbStats.replaceChildren(
      kv("Database size", formatBytes(db.hubBytes)),
      kv("WAL", formatBytes(db.walBytes)),
      kv("SHM", formatBytes(db.shmBytes)),
      kv("Pages", formatNumber(db.pageCount)),
      kv("Journal mode", db.journalMode || "unknown"),
      kv("Accepted", formatNumber(s.counts?.accepted)),
      kv("Pending parent", badge(formatNumber(s.counts?.pendingParent), Number(s.counts?.pendingParent) > 0 ? "warning" : "ok")),
      kv("Quarantined", badge(formatNumber(s.counts?.quarantined), Number(s.counts?.quarantined) > 0 ? "warning" : "ok")),
    );
    svcStats.replaceChildren(
      kv("Process ID", String(proc.pid ?? "—")),
      kv("Uptime", formatDuration(proc.uptimeSec * 1000)),
      kv("Active handles", formatNumber(proc.activeHandles)),
      kv("Active connections", formatNumber(proc.activeConnections)),
      kv("Health", badge(svc.health || "unknown", /down|critical/i.test(svc.health || "") ? "critical" : "ok")),
      kv("Last ingest", timeAgo(svc.lastIngestAt)),
      kv("Last checkpoint", timeAgo(svc.lastCheckpointAt)),
      kv("Last backup", timeAgo(svc.lastBackupAt)),
      kv("Host available", host.available ? "Yes" : "No"),
      kv("Platform", `${host.platform || "—"} ${host.release || ""}`),
    );
  }

  return render;
}

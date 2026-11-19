import { el, card, badge, stat, toast, copyButton, actionButton } from "../lib/dom.js";
import {
  percentSeverity, diskSeverity, chainSeverity, backupSeverity,
  outboxSeverity, deriveAlerts, iconForSeverity, labelForSeverity, severityClass, nicUtilization,
} from "../lib/status.js";
import { formatBytes, formatRate, formatPercent, formatNumber, formatAge, timeAgo, shortHash } from "../lib/format.js";
import { pageTitle, chartCard, alertsList, scoreRing, breakdownChips, kv } from "./common.js";

export function mountOverview(main, ctx) {
  const { charts, dom, format, status, score, api } = ctx;

  main.appendChild(pageTitle("Overview", "Health, data safety and live activity at a glance"));

  /* ----------------------------- status ribbon ---------------------------- */
  const ribbon = el("div", { class: "status-ribbon" });
  let healthBadge = badge("Unknown", "info");
  let connBadge = badge(ctx.isDemo ? "demo" : "offline", ctx.isDemo ? "info" : "info");
  const ribbonScore = el("div", { class: "ribbon-score" });
  const scoreText = el("div", { class: "score-summary" }, [
    el("strong", { text: "—" }),
    el("span", { text: "Data Safety Score" }),
  ]);
  const updated = el("span", { class: "muted", text: "Last update: —" });
  const breakdown = el("div", { class: "breakdown" });
  const ribbonTop = el("div", { class: "row" }, [healthBadge, connBadge, ribbonScore, updated]);
  ribbon.append(ribbonTop, breakdown);
  main.appendChild(ribbon);

  /* -------------------------------- hero -------------------------------- */
  const hero = el("div", { class: "hero-grid" });
  const heroDefs = [
    ["Host CPU", "gauge"], ["Memory", "gauge"], ["System disk", "gauge"], ["Network throughput", "gauge"],
  ];
  const heroCards = heroDefs.map(([title]) => {
    const c = chartCard(title, "gauge", { footer: true });
    const sub = el("div", { class: "spark-box" });
    c.card.querySelector(".card-body").appendChild(sub);
    hero.appendChild(c.card);
    return { ...c, sub };
  });
  main.appendChild(hero);

  /* ------------------------------ two columns ----------------------------- */
  const row1 = el("div", { class: "two-col" });
  main.appendChild(row1);

  // Device activity: demo shows simulated load %, live shows real accepted-bundle counts.
  const deviceCard = card({
    title: ctx.isDemo ? "Devices & load" : "Devices & activity",
    subtitle: ctx.isDemo ? "Online nodes and recent load" : "Online nodes and accepted bundles (5 min)",
  });
  const deviceDonut = el("div", { class: "gauge-box" });
  const deviceBars = el("div", { class: "chart-box" });
  const deviceMeta = el("div", { class: "chart-card-footer" });
  deviceCard.querySelector(".card-body").append(deviceDonut, deviceBars, deviceMeta);
  row1.appendChild(deviceCard);

  // SAL / replica
  const replicaCard = card({ title: "Storage & replicas", subtitle: "Cloud replica, upload queue and backup" });
  const replicaBody = replicaCard.querySelector(".card-body");
  const replicaMeta = el("div", { class: "stack" });
  const outboxDonut = el("div", { class: "gauge-box" });
  replicaBody.append(replicaMeta, outboxDonut);
  row1.appendChild(replicaCard);

  // Chain
  const chainCard = card({ title: "Hash chain", subtitle: "Append-only integrity ledger" });
  const chainBody = chainCard.querySelector(".card-body");
  const chainShield = el("div", { class: "row" });
  const chainStats = el("div", { class: "stack" });
  const chainStripBox = el("div", { class: "chart-box" });
  const chainVerifyBtn = actionButton("Verify chain", async () => {
    try {
      const r = await api("/api/v1/admin/maintenance/verify-chain", { method: "POST" });
      toast(r && r.ok === false ? "Integrity check found a problem" : "Integrity check complete", r && r.ok === false ? "critical" : "ok");
      if (ctx.boot) ctx.boot();
    } catch (e) { toast(e.message, "warning"); }
  }, { primary: true });
  chainBody.append(chainShield, chainStats, chainStripBox, chainVerifyBtn);
  row1.appendChild(chainCard);

  // Alerts
  const alertsCard = card({ title: "Alerts", subtitle: "Plain-language health signals" });
  const alertsBody = el("div", { class: "alert-list" });
  alertsCard.querySelector(".card-body").appendChild(alertsBody);
  row1.appendChild(alertsCard);

  /* ---------------------------- running charts ---------------------------- */
  const row2 = el("div", { class: "two-col" });
  main.appendChild(row2);
  const cpuMem = chartCard("CPU & memory", "tall", { subtitle: "Recent host samples", footer: true });
  const net = chartCard("Network in / out", "tall", { subtitle: "Bytes per second", footer: true });
  row2.append(cpuMem.card, net.card);

  const row3 = el("div", { class: "two-col" });
  main.appendChild(row3);
  const rate = chartCard("Ingest & event rate", "chart", { subtitle: "Per second", footer: true });
  const growth = chartCard("Database growth", "chart", { subtitle: "Local replica size", footer: true });
  row3.append(rate.card, growth.card);

  /* -------------------------------- render ------------------------------- */
  function render(sample) {
    const s = sample || {};
    const host = s.host || {};
    const h = (s.history || ctx.history || {});
    const disks = Array.isArray(s.disks) ? s.disks : [];
    const nics = Array.isArray(s.network) ? s.network : [];
    const health = s.health || {};
    const healthSev = /down|critical/i.test(health.status || "") ? "critical"
      : /degrad|warn/i.test(health.status || "") ? "warning" : "ok";

    // ribbon
    healthBadge = badge(labelForSeverity(healthSev) + " · " + (health.status || "unknown"), healthSev);
    const connLabel = ctx.isDemo ? "demo data" : String(s.connectionState || "live");
    connBadge = badge(connLabel, ctx.isDemo ? "info" : "ok");
    ribbonTop.replaceChildren(healthBadge, connBadge, ribbonScore, updated);
    const sc = score(s);
    scoreText.firstChild.textContent = `${sc.score}/100 · ${sc.label}`;
    ribbonScore.replaceChildren(scoreRing(sc.score), scoreText);
    updated.textContent = `Last update: ${timeAgo(s.sampledAt)}`;
    breakdown.replaceChildren(breakdownChips(sc.breakdown));

    // hero gauges
    const cpu = Number(host.cpuPercentTotal ?? s.process?.cpuPercent);
    const totalMem = Number(host.memoryTotalBytes);
    const usedMem = Number(host.memoryUsedBytes);
    const memPct = totalMem > 0 ? (usedMem / totalMem) * 100 : null;
    const mainDisk = disks[0] || {};
    const rx = Number(s.rates?.rxBytesPerSec ?? nics.reduce((a, n) => a + Number(n.rxBytesPerSec || 0), 0));
    const tx = Number(s.rates?.txBytesPerSec ?? nics.reduce((a, n) => a + Number(n.txBytesPerSec || 0), 0));
    const linkSpeed = Math.max(1, ...nics.map((n) => Number(n.linkSpeedMbps || 1000)));
    const netMbps = ((rx + tx) * 8) / 1e6;
    const cpuHist = h.hostCpu || h.cpu || [];
    const memHist = h.hostMemUsedPercent || h.memory || [];
    const diskHist = h.disk || [];
    const rxHist = h.networkRx || [];
    const txHist = h.networkTx || [];

    const gauges = [
      {
        value: cpu, min: 0, max: 100, unit: "%", label: "of 100%",
        thresholds: status.THRESHOLDS.cpu, hist: cpuHist, color: 0,
        sub: `Process ${formatPercent(s.process?.cpuPercent)}`,
      },
      {
        value: memPct, min: 0, max: 100, unit: "%", label: formatBytes(usedMem) + " used",
        thresholds: status.THRESHOLDS.memory, hist: memHist, color: 1,
        sub: `${formatBytes(totalMem)} total`,
      },
      {
        value: mainDisk.usedPercent, min: 0, max: 100, unit: "%", label: mainDisk.mount || "volume",
        thresholds: status.THRESHOLDS.disk, hist: diskHist, color: 2,
        sub: `${formatBytes(mainDisk.freeBytes)} free`,
      },
      {
        value: netMbps, min: 0, max: linkSpeed, unit: " Mb/s", label: "combined",
        thresholds: { warning: linkSpeed * 0.8, critical: linkSpeed * 0.95 },
        hist: rxHist.map((v, i) => ((Number(v) + Number(txHist[i] || 0)) * 8) / 1e6), color: 3,
        sub: `↓ ${formatRate(rx)} · ↑ ${formatRate(tx)}`,
      },
    ];
    heroCards.forEach((c, i) => {
      const g = gauges[i];
      charts.gauge(c.body, g);
      charts.sparkline(c.sub, g.hist, { color: g.color, fill: true });
      c.footer.replaceChildren(el("span", { text: g.sub }));
    });

    // device donut + bars
    const devices = Array.isArray(s.devices) ? s.devices : [];
    const online = devices.filter((d) => d && d.online === true).length;
    const total = devices.length || Number(s.counts?.devices || 0);
    charts.donut(deviceDonut, {
      segments: [
        { value: online, label: "Online", severity: "ok" },
        { value: Math.max(0, total - online), label: "Offline / stale", severity: total - online > 0 ? "warning" : "ok" },
      ],
      centerValue: `${online}/${total}`,
      centerLabel: "online",
    });
    const deviceActivity = devices.map((d) => {
      const hasLoad = Array.isArray(d.recentLoad) && d.recentLoad.length > 0;
      const raw = hasLoad ? d.recentLoad.slice(-1)[0] : d.recentAccepted;
      const value = Math.max(0, Number(raw) || 0);
      return {
        label: d.label || d.prefix || d.id,
        value,
        display: ctx.isDemo && hasLoad ? `${Math.round(value)}%` : String(Math.round(value)),
        // Live counts are activity, not CPU load — never apply CPU thresholds to them.
        severity: ctx.isDemo && hasLoad ? percentSeverity("cpu", value) : "info",
      };
    });
    charts.bars(deviceBars, {
      items: deviceActivity,
      max: ctx.isDemo ? 100 : Math.max(1, ...deviceActivity.map((i) => i.value)),
      unit: ctx.isDemo ? "%" : "bundles",
      thresholds: ctx.isDemo ? status.THRESHOLDS.cpu : undefined,
    });
    deviceMeta.replaceChildren(
      el("span", { text: `${online} of ${total} devices online` }),
      el("span", { text: `${formatNumber(s.counts?.accepted)} accepted · ${formatNumber(s.counts?.quarantined)} to review` }),
    );

    // SAL / replica
    const replica = s.replica || {};
    const sal = replica.sal || {};
    const outbox = s.outbox || {};
    const counts = outbox.counts || {};
    const salSev = sal.connected ? "ok" : "warning";
    replicaMeta.replaceChildren(
      kv("Replica target", el("span", { text: replica.target || "not configured" })),
      kv("Cloud storage", badge(sal.connected ? `${sal.provider || "Drive"} connected` : "Not configured", salSev)),
      kv("Cloud usage", sal.connected ? `${formatBytes(sal.usedBytes)} / ${formatBytes(sal.quotaBytes)}` : "—"),
      kv("Last upload", timeAgo(sal.lastUploadAt)),
      kv("Oldest pending", formatAge(outbox.oldestPendingAgeMs)),
      ctx.isDemo ? el("div") : el("div", { class: "muted", text: "Monitored 1 of 4 replicas — cloud replica not connected" }),
    );
    charts.donut(outboxDonut, {
      segments: [
        { value: counts.done || 0, label: "Uploaded", severity: "ok" },
        { value: counts.uploading || 0, label: "Uploading", severity: "info" },
        { value: counts.pending || 0, label: "Waiting", severity: "warning" },
        { value: counts.failed || 0, label: "Needs retry", severity: "critical" },
      ],
      centerValue: String(Object.values(counts).reduce((a, b) => Number(a) + Number(b), 0)),
      centerLabel: "queue items",
    });

    // chain
    const chain = s.chain || {};
    const verify = chain.verify || {};
    const cSev = chainSeverity(verify, verify.verifiedAt);
    chainShield.replaceChildren(
      badge(`Integrity: ${verify.ok === true ? "verified" : verify.ok === false ? "FAILED" : "unknown"}`, cSev),
      el("span", { class: "muted", text: cSev === "ok" ? "Protected" : labelForSeverity(cSev) }),
    );
    chainStats.replaceChildren(
      kv("Accepted sequence", formatNumber(chain.latestAcceptedSeq)),
      kv("Latest hash", el("span", { class: "row" }, [
        el("span", { text: shortHash(chain.latestChainHash) }),
        copyButton(() => chain.latestChainHash),
      ])),
      kv("Last verified", timeAgo(verify.verifiedAt) + (verify.stale ? " · stale" : "")),
      kv("Backup", backupSeverity(s.backup?.lastAt) === "ok" ? timeAgo(s.backup?.lastAt) : "Needs attention"),
    );
    charts.chainStrip(chainStripBox, { items: chain.recent || [], status: verify.ok ? "ok" : "critical" });

    // alerts
    alertsBody.replaceChildren(alertsList(deriveAlerts(s)));

    // running charts
    charts.lineChart(cpuMem.body, {
      series: [
        { name: "CPU %", values: cpuHist, fill: true },
        { name: "Memory %", values: memHist, fill: true },
      ],
      unit: "%", min: 0, max: 100, legend: true,
      timeLabels: (h.timeLabels || []).slice(-cpuHist.length),
    });
    cpuMem.footer.replaceChildren(
      el("span", { text: `CPU now ${formatPercent(cpu)}` }),
      el("span", { text: `Memory now ${formatPercent(memPct)}` }),
    );
    charts.lineChart(net.body, {
      series: [
        { name: "Received", values: rxHist, fill: true },
        { name: "Sent", values: txHist, fill: true },
      ],
      unit: "B/s", legend: true,
      timeLabels: (h.timeLabels || []).slice(-rxHist.length),
    });
    net.footer.replaceChildren(
      el("span", { text: `↓ ${formatRate(rx)}` }),
      el("span", { text: `↑ ${formatRate(tx)}` }),
    );
    charts.lineChart(rate.body, {
      series: [
        { name: "Accepted", values: h.acceptedPerSec || h.ingest || [], fill: true },
        { name: "Events", values: h.eventsPerSec || [], fill: true },
      ],
      unit: "/s", legend: true,
      timeLabels: (h.timeLabels || []).slice(-(h.acceptedPerSec || []).length),
    });
    rate.footer.replaceChildren(el("span", { text: `${(h.acceptedPerSec || []).slice(-1)[0] ?? 0}/s accepted` }));
    charts.lineChart(growth.body, {
      series: [{ name: "Database", values: h.dbBytes || [], fill: true }],
      legend: true,
      timeLabels: (h.timeLabels || []).slice(-(h.dbBytes || []).length),
    });
    growth.footer.replaceChildren(
      el("span", { text: `Now ${formatBytes(s.db?.hubBytes)}` }),
      el("span", { text: `WAL ${formatBytes(s.db?.walBytes)}` }),
    );
  }

  return render;
}

import { el, card, badge, actionButton, copyButton, dataTable, toast, stat } from "../lib/dom.js";
import { chainSeverity, diskSeverity, backupSeverity, labelForSeverity, severityClass } from "../lib/status.js";
import { formatBytes, formatNumber, timeAgo, shortHash } from "../lib/format.js";
import { pageTitle, chartCard, kv } from "./common.js";

export function mountMaintenance(main, ctx) {
  const { api, charts } = ctx;

  main.appendChild(pageTitle("Maintenance", "Integrity, storage, backups and audit trail"));

  const quick = el("div", { class: "kpi-grid" });
  main.appendChild(quick);

  const row1 = el("div", { class: "two-col" });
  const chainCard = card({ title: "Hash chain", subtitle: "Append-only integrity ledger" });
  const chainBody = el("div", { class: "stack" });
  const chainStrip = el("div", { class: "chart-box" });
  const verifyBtn = actionButton("Verify chain", async () => {
    try {
      const r = await api("/api/v1/admin/maintenance/verify-chain", { method: "POST" });
      toast(r && r.ok === false ? "Integrity problem found — review the chain detail" : "Integrity verified", r && r.ok === false ? "critical" : "ok");
      if (ctx.boot) ctx.boot();
    } catch (e) { toast(e.message, "warning"); }
  }, { primary: true });
  chainBody.appendChild(chainStrip);
  chainCard.querySelector(".card-body").append(chainBody, el("div", { class: "row" }, [verifyBtn]));
  const storageCard = card({ title: "Storage & SAL", subtitle: "Replica target and upload queue" });
  const storageBody = el("div", { class: "stack" });
  storageCard.querySelector(".card-body").appendChild(storageBody);
  row1.append(chainCard, storageCard);
  main.appendChild(row1);

  const growth = chartCard("Database growth", "chart", { subtitle: "Local replica size over time", footer: true });
  main.appendChild(growth.card);

  const row2 = el("div", { class: "two-col" });
  const backupCard = card({ title: "Backups", subtitle: "Local snapshots" });
  const backupBody = el("div", { class: "stack" });
  const backupList = el("div", { class: "stack" });
  const createBtn = actionButton("Create backup", async () => {
    try {
      const r = await api("/api/v1/admin/backups", { method: "POST" });
      toast("Backup created", "ok");
      loadBackups();
    } catch (e) { toast(e.message, "warning"); }
  }, { primary: true });
  const checkpointBtn = actionButton("Checkpoint WAL", async () => {
    try {
      await api("/api/v1/admin/maintenance/checkpoint", { method: "POST" });
      toast("WAL checkpoint complete", "ok");
    } catch (e) { toast(e.message, "warning"); }
  });
  backupCard.querySelector(".card-body").append(backupBody, backupList, el("div", { class: "row" }, [createBtn, checkpointBtn]));
  const auditCard = card({ title: "Audit log", subtitle: "Recent admin actions" });
  const auditBody = el("div", { class: "stack" });
  auditCard.querySelector(".card-body").appendChild(auditBody);
  row2.append(backupCard, auditCard);
  main.appendChild(row2);

  async function loadBackups() {
    try {
      const data = await api("/api/v1/admin/backups");
      const items = Array.isArray(data.items) ? data.items : [];
      backupList.replaceChildren(dataTable([
        { key: "name", label: "Backup" },
        { key: "size", label: "Size", render: (b) => formatBytes(b.size) },
        { key: "age", label: "Created", render: (b) => timeAgo(new Date(b.mtimeMs).toISOString()) },
        { key: "actions", label: "Download", render: (b) => el("a", { class: "btn btn-ghost", href: `/api/v1/admin/backups/${encodeURIComponent(b.name)}/download`, text: "Download" }) },
      ], items, { emptyMessage: "No backups yet" }));
    } catch (e) { ctx.showError(e.message); }
  }

  async function loadAudit() {
    try {
      const data = await api("/api/v1/admin/audit?limit=20");
      const items = Array.isArray(data.items) ? data.items : [];
      auditBody.replaceChildren(dataTable([
        { key: "at", label: "When", render: (a) => timeAgo(a.at) },
        { key: "action", label: "Action" },
        { key: "actor", label: "Actor", render: (a) => a.actor || "admin" },
      ], items, { emptyMessage: "No audit entries yet" }));
    } catch (e) { ctx.showError(e.message); }
  }

  function render(sample) {
    if (!sample) return;
    const chain = sample.chain || {};
    const verify = chain.verify || {};
    const cSev = chainSeverity(verify, verify.verifiedAt);
    const replica = sample.replica || {};
    const sal = replica.sal || {};
    const outbox = sample.outbox || {};
    const counts = outbox.counts || {};
    const db = sample.db || {};
    const backup = sample.backup || {};
    const disks = Array.isArray(sample.disks) ? sample.disks : [];
    const mainDisk = disks[0] || {};
    const dSev = diskSeverity(mainDisk.usedPercent, mainDisk.freeBytes);
    const bSev = backupSeverity(backup.lastAt || sample.service?.lastBackupAt);

    quick.replaceChildren(
      stat("Integrity", verify.ok === true ? "Verified" : verify.ok === false ? "FAILED" : "Unknown", { severity: cSev }),
      stat("Accepted sequence", formatNumber(chain.latestAcceptedSeq)),
      stat("Backup", backup.lastAt ? timeAgo(backup.lastAt) : "None", { severity: bSev }),
      stat("Disk free", formatBytes(mainDisk.freeBytes), { severity: dSev }),
    );

    chainBody.replaceChildren(
      kv("Status", badge(labelForSeverity(cSev) + " · " + (verify.ok === true ? "verified" : verify.ok === false ? "failed" : "unknown"), cSev)),
      kv("Accepted sequence", formatNumber(chain.latestAcceptedSeq)),
      kv("Hub sequence", formatNumber(chain.latestHubSeq)),
      kv("Latest hash", el("span", { class: "row" }, [el("span", { text: shortHash(chain.latestChainHash) }), copyButton(() => chain.latestChainHash)])),
      kv("Items checked", formatNumber(verify.checked)),
      kv("First bad accepted seq", verify.firstBadAcceptedSeq ?? "—"),
      kv("First bad hub seq", verify.firstBadHubSeq ?? "—"),
      kv("Last verified", timeAgo(verify.verifiedAt)),
      verify.stale ? el("p", { class: "alert alert-warning", text: "Integrity check is over 24 hours old. Run Verify chain." }) : null,
      verify.ok === false ? el("p", { class: "alert alert-critical", text: "Integrity check failed. Restore from a known-good backup before continuing." }) : null,
    );
    charts.chainStrip(chainStrip, { items: chain.recent || [], status: verify.ok ? "ok" : "critical" });

    storageBody.replaceChildren(
      kv("Replica target", replica.target || "none"),
      kv("Cloud storage", badge(sal.connected ? `${sal.provider || "Drive"} connected` : "Not configured", sal.connected ? "ok" : "warning")),
      kv("Cloud health", sal.health || "—"),
      kv("Cloud usage", sal.connected ? `${formatBytes(sal.usedBytes)} / ${formatBytes(sal.quotaBytes)}` : "—"),
      kv("Last upload", timeAgo(sal.lastUploadAt)),
      kv("Manifest", replica.manifest?.aligned ? "Aligned" : "Local manifest only"),
      kv("Number relay", replica.numberRelay?.active ? "Active" : "Not implemented"),
      kv("Upload queue", el("div", { class: "row" }, [
        el("span", { class: "pill", text: `Waiting ${formatNumber(counts.pending)}` }),
        el("span", { class: "pill", text: `Uploading ${formatNumber(counts.uploading)}` }),
        el("span", { class: "pill", text: `Done ${formatNumber(counts.done)}` }),
        el("span", { class: "pill", text: `Failed ${formatNumber(counts.failed)}` }),
      ])),
      kv("Oldest pending", timeAgo(new Date(Date.now() - Number(outbox.oldestPendingAgeMs || 0)).toISOString())),
      kv("Last successful upload", timeAgo(outbox.lastSuccessAt)),
      ...(Array.isArray(outbox.lastErrors) && outbox.lastErrors.length
        ? outbox.lastErrors.map((e) => el("p", { class: "alert alert-warning", text: `${e.bundleId}: ${e.lastError || "upload failed"}` }))
        : []),
      el("div", { class: "divider" }),
      kv("Database size", formatBytes(db.hubBytes)),
      kv("WAL / SHM", `${formatBytes(db.walBytes)} / ${formatBytes(db.shmBytes)}`),
      kv("Page count / size", `${formatNumber(db.pageCount)} · ${formatBytes(db.pageSize)}`),
      kv("Journal mode", db.journalMode || "unknown"),
      kv("Disk free (min 10 GB)", el("span", { text: `${formatBytes(mainDisk.freeBytes)} used ${formatPercentSafe(mainDisk.usedPercent)}` })),
    );

    backupBody.replaceChildren(
      kv("Last backup", backup.lastAt ? timeAgo(backup.lastAt) : "Never"),
      kv("Last size", formatBytes(backup.lastSize || backup.items?.[0]?.size)),
      kv("Backup count", formatNumber(backup.count ?? (backup.items || []).length)),
      kv("Policy", `Warn after ${backup.policy?.warningAfterHours || 24}h · keep ${formatBytes(backup.policy?.minFreeBytes || 10e9)} free`),
      kv("Running", backup.running ? "Yes" : "No"),
    );

    const h = sample.history || ctx.history || {};
    charts.lineChart(growth.body, {
      series: [{ name: "Database", values: h.dbBytes || [], fill: true }],
      legend: true, timeLabels: h.timeLabels || [],
    });
    growth.footer.replaceChildren(el("span", { text: `Now ${formatBytes(db.hubBytes)}` }));
  }

  function formatPercentSafe(v) {
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n)}%` : "—";
  }

  loadBackups();
  loadAudit();
  return render;
}

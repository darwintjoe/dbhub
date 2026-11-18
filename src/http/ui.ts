import type { Request, Response } from "express";
import type { Config } from "../config";
import type { BundlesRepo } from "../db/bundles.repo";
import type { DevicesRepo } from "../db/devices.repo";

export function uiHandler(config: Config, bundles: BundlesRepo, devices: DevicesRepo) {
  return (_req: Request, res: Response) => {
    const counts = {
      devices: bundles.countDevices(),
      accepted: bundles.countByStatus("accepted"),
      pendingParent: bundles.countByStatus("pending_parent"),
      quarantined: bundles.countByStatus("quarantined"),
      events: bundles.countEvents(),
    };
    const latest = bundles.acceptedHead();
    const insertionHead = bundles.lastAcceptedHead();
    const deviceRows = devices.list(config.companyId);
    const recent = bundles.recent(20);
    const quarantineCount = bundles.countByStatus("quarantined");

    const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c] as string));

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10">
<title>FAZAI Hub</title>
<style>
body{font-family:system-ui,Arial,sans-serif;margin:20px;background:#f7f7f9;color:#222}
h1{margin:0 0 12px}
.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0}
table{width:100%;border-collapse:collapse}
th,td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;background:#eef;font-size:12px}
</style></head><body>
<h1>FAZAI Hub <span class="badge">${esc(config.companyId)}</span></h1>
<div class="card">
<p>Version 0.1.1 | Uptime ${Math.floor(process.uptime())}s | Latest acceptedSeq ${latest ? (latest.acceptedSeq ?? 0) : 0} | Latest hubSeq (insertion order) ${insertionHead ? insertionHead.hubSeq : 0}</p>
<p>Devices: ${counts.devices} | Accepted: ${counts.accepted} | Pending parent: ${counts.pendingParent} | Quarantined: ${counts.quarantined} | Events: ${counts.events}</p>
<p>Latest chain hash: ${esc(latest ? latest.chainHash : "none")}</p>
</div>
<div class="card">
<h2>Devices</h2>
<table><tr><th>ID</th><th>Prefix</th><th>Label</th><th>Status</th><th>Last seen</th></tr>
${deviceRows.map((d) => `<tr><td>${esc(d.id)}</td><td>${esc(d.prefix)}</td><td>${esc(d.label)}</td><td>${esc(d.status)}</td><td>${esc(d.lastSeenAt)}</td></tr>`).join("")}
</table></div>
<div class="card">
<h2>Last 20 bundles</h2>
<table><tr><th>AcceptedSeq</th><th>HubSeq (insert)</th><th>Bundle</th><th>Device</th><th>Events</th><th>Status</th><th>Time</th></tr>
${recent.map((b) => `<tr><td>${b.acceptedSeq ?? "-"}</td><td>${b.hubSeq}</td><td>${esc(b.bundleId)}</td><td>${esc(b.deviceId)}</td><td>${b.eventCount}</td><td>${esc(b.status)}</td><td>${esc(b.receivedAt)}</td></tr>`).join("")}
</table></div>
<div class="card">
<h2>Quarantine</h2>
<p>Count: ${quarantineCount}</p>
</div>
<div class="card">
<button onclick="verifyChain()">Verify chain</button>
<pre id="verify"></pre>
<script>
async function verifyChain(){
  const token = prompt('Admin token');
  if(!token) return;
  const r = await fetch('/api/v1/admin/maintenance/verify-chain',{method:'POST',headers:{Authorization:'Bearer '+token}});
  document.getElementById('verify').textContent = await r.text();
}
</script>
</div>
</body></html>`;
    res.type("html").send(html);
  };
}

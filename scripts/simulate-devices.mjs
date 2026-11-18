import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const PORT = 18887;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fazai-hub-sim-"));
const dataDir = path.join(tmp, "data");
const configPath = path.join(tmp, "config.json");
const adminToken = "sim-admin-token";
const adminTokenHash = crypto.createHash("sha256").update(adminToken, "utf8").digest("hex");

const config = {
  companyId: "cmp_sim",
  replicaId: "hub_sim",
  port: PORT,
  host: "127.0.0.1",
  adminTokenHash,
  dataDir,
  logDir: path.join(tmp, "logs"),
  storage: { target: "null", folderPath: "" },
  limits: { maxBodyBytes: 5242880, ratePerMinutePerDevice: 10000, ratePerMinutePerIp: 10000 },
  quarantine: { pendingParentTimeoutMs: 86400000 },
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: process.cwd(),
  env: { ...process.env, FAZAI_HUB_CONFIG: configPath, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stderr.write(d));
child.stderr.on("data", (d) => process.stderr.write(d));

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error("hub did not start");
}
await waitForHealth();
const base = `http://127.0.0.1:${PORT}`;

const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

function payloadHash(payload) {
  return sha256(canonicalJson(payload));
}
function bundleHash(b) {
  const copy = { ...b };
  delete copy.bundleHash;
  return sha256(canonicalJson(copy));
}

async function admin(pathname, body) {
  const r = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`admin ${pathname} ${r.status}: ${await r.text()}`);
  return r.json();
}

// Register 3 devices.
const devices = [];
for (let i = 0; i < 3; i++) {
  const d = await admin("/api/v1/admin/devices", { label: `SIM-${i + 1}`, prefix: `SIM${i + 1}` });
  devices.push(d);
}

function makeEvents(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      id: `evt_${uuid()}`,
      type: "journal.posted",
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { i, amount: 100 + i },
    });
  }
  return events;
}

// Generate 100 valid bundles per device with correct per-device hash chains.
const deviceBundles = devices.map((d) => {
  const bundles = [];
  let prevHash = null;
  for (let i = 0; i < 100; i++) {
    const payload = makeEvents(1 + Math.floor(Math.random() * 10));
    const b = {
      bundleId: `bdl_${uuid()}`,
      companyId: "cmp_sim",
      ledgerStreamId: "main",
      deviceId: d.deviceId,
      userId: "user_sim",
      period: "2026-11",
      devicePrevHash: prevHash,
      payloadHash: "",
      bundleHash: "",
      eventCount: payload.length,
      schemaVersion: 1,
      bundleFormatVersion: 1,
      createdAt: new Date().toISOString(),
      payload,
    };
    b.payloadHash = payloadHash(payload);
    b.bundleHash = bundleHash(b);
    prevHash = b.bundleHash;
    bundles.push(b);
  }
  return { device: d, bundles };
});

let accepted = 0;
let quarantined = 0;
let duplicates = 0;
let pending = 0;

async function postBundle(b, token) {
  const r = await fetch(base + "/api/v1/relay/bundles", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(b),
  });
  const j = await r.json();
  if (j.status === "accepted") accepted++;
  else if (j.status === "quarantined") quarantined++;
  else if (j.status === "duplicate") duplicates++;
  else if (j.status === "pending_parent") pending++;
  return j;
}

// Post in shuffled order, with random delays and occasional retries.
for (const db of deviceBundles) {
  const token = db.device.token;
  const order = db.bundles.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const firstPost = new Map();
  for (const idx of order) {
    await sleep(Math.floor(Math.random() * 10));
    // Ensure a chain root is posted first; then post N+1 before N on purpose
    // for some adjacent pairs so pending_parent resolution is exercised.
    if (idx === 0) {
      await postBundle(db.bundles[idx], token);
      firstPost.set(idx, true);
    } else if (idx > 1 && idx % 5 === 0 && !firstPost.has(idx - 1)) {
      await postBundle(db.bundles[idx], token);
      await sleep(5);
      await postBundle(db.bundles[idx - 1], token);
      firstPost.set(idx, true);
      firstPost.set(idx - 1, true);
    } else if (!firstPost.has(idx)) {
      await postBundle(db.bundles[idx], token);
      firstPost.set(idx, true);
    }
    // Occasional retry of an already-posted bundle (idempotency check).
    if (Math.random() < 0.05) await postBundle(db.bundles[idx], token);
  }
}

// Extra tampered bundle: mutate payload but keep stale hashes.
const tampered = JSON.parse(JSON.stringify(deviceBundles[0].bundles[0]));
tampered.bundleId = `bdl_${uuid()}`;
tampered.payload[0].data = { hacked: true };
// Keep the hash unique so insertion succeeds; hashes stay stale => hash_mismatch.
tampered.bundleHash = sha256(`tampered-${uuid()}`);
await sleep(10);
await postBundle(tampered, deviceBundles[0].device.token);

// Extra duplicate: repost first valid bundle.
await sleep(10);
await postBundle(deviceBundles[0].bundles[0], deviceBundles[0].device.token);

// Allow pending resolution to settle.
await sleep(1000);

const stRes = await fetch(base + "/api/v1/status", {
  headers: { Authorization: `Bearer ${adminToken}` },
});
const st = await stRes.json();
console.log(JSON.stringify(st, null, 2));

let ok = true;
const failures = [];
if (st.counts.accepted !== 300) {
  ok = false;
  failures.push(`accepted ${st.counts.accepted} !== 300`);
}
if (st.counts.pendingParent !== 0) {
  ok = false;
  failures.push(`pendingParent ${st.counts.pendingParent} !== 0`);
}
if (st.counts.quarantined < 1) {
  ok = false;
  failures.push(`quarantined ${st.counts.quarantined} < 1`);
}

// Pull all accepted bundles in order.
let since = 0;
let pulled = 0;
let lastSeq = 0;
while (true) {
  const r = await fetch(base + `/api/v1/pull?since=${since}&limit=200`, {
    headers: { Authorization: `Bearer ${deviceBundles[0].device.token}` },
  });
  const j = await r.json();
  if (!j.bundles.length) break;
  for (const b of j.bundles) {
    if (b.hubSeq <= lastSeq) {
      ok = false;
      failures.push("pull not ordered");
    }
    lastSeq = b.hubSeq;
  }
  pulled += j.bundles.length;
  since = j.nextSince;
  if (j.bundles.length < 200) break;
}
if (pulled !== 300) {
  ok = false;
  failures.push(`pulled ${pulled} !== 300`);
}

// Chain verify.
const vr = await fetch(base + "/api/v1/admin/maintenance/verify-chain", {
  method: "POST",
  headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
});
const v = await vr.json();
console.log("verify:", JSON.stringify(v));
if (!v.ok || v.checked !== 300) {
  ok = false;
  failures.push(`chain verify ${JSON.stringify(v)}`);
}

// Manifest.
const mr = await fetch(base + "/api/v1/manifest", {
  headers: { Authorization: `Bearer ${deviceBundles[0].device.token}` },
});
const m = await mr.json();
if (m.latestHubSeq !== lastSeq) {
  ok = false;
  failures.push(`manifest latest ${m.latestHubSeq} !== ${lastSeq}`);
}
if (m.latestAcceptedSeq !== 300) {
  ok = false;
  failures.push(`manifest latestAcceptedSeq ${m.latestAcceptedSeq} !== 300`);
}

const diagDb = new Database(path.join(dataDir, "hub.sqlite"), { readonly: true });
console.log("diag statuses", diagDb.prepare("SELECT status, COUNT(*) AS c FROM bundles GROUP BY status").all());
console.log("diag by device", diagDb.prepare("SELECT device_id, status, COUNT(*) AS c FROM bundles GROUP BY device_id, status").all());
diagDb.close();

child.kill();
if (ok) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
} else {
  console.error("temp kept at", tmp);
}

if (!ok) {
  console.error("SIMULATION FAILED:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("SIMULATION PASSED");
process.exit(0);

import Database from "better-sqlite3";
import crypto from "node:crypto";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: node scripts/verify-chain.mjs <sqlitePath>");
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare("SELECT hub_seq, accepted_seq, bundle_hash, chain_prev_hash, chain_hash FROM bundles WHERE status='accepted' ORDER BY accepted_seq ASC").all();
let prev = null;
let checked = 0;
for (const r of rows) {
  checked++;
  if (r.chain_prev_hash !== prev) {
    console.log(JSON.stringify({ ok: false, checked, firstBadAcceptedSeq: r.accepted_seq, firstBadHubSeq: r.hub_seq }));
    process.exit(1);
  }
  const input = prev === null ? r.bundle_hash : `${prev}:${r.bundle_hash}`;
  const expected = crypto.createHash("sha256").update(input, "utf8").digest("hex");
  if (r.chain_hash !== expected) {
    console.log(JSON.stringify({ ok: false, checked, firstBadAcceptedSeq: r.accepted_seq, firstBadHubSeq: r.hub_seq }));
    process.exit(1);
  }
  prev = r.chain_hash;
}
console.log(JSON.stringify({ ok: true, checked }));
db.close();

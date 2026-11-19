import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import BetterSqlite3 from "better-sqlite3";

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const dataDir = arg("--data-dir") || process.env.DBHUB_DATA_DIR || path.resolve(process.cwd(), "data");
const dbPath = path.join(dataDir, "hub.sqlite");
const reset = process.argv.includes("--reset");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new BetterSqlite3(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);

const existingHash = db.prepare("SELECT value FROM app_state WHERE key='setup.code_hash'").get();
const existingExpires = db.prepare("SELECT value FROM app_state WHERE key='setup.code_expires_at'").get();
const unexpired = existingHash && existingExpires && Date.now() < Date.parse(existingExpires.value);

if (unexpired && !reset) {
  console.log("A setup code already exists and is unexpired.");
  console.log("Run `npm run setup-code -- --reset` to generate a new one.");
  db.close();
  process.exit(0);
}

const codeRaw = crypto.randomBytes(16).toString("hex").toUpperCase();
const code = codeRaw.match(/.{1,8}/g).join("-");
const hash = crypto.createHash("sha256").update(code, "utf8").digest("hex");
const now = new Date();
const expires = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_hash", hash, now.toISOString());
db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_created_at", now.toISOString(), now.toISOString());
db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_expires_at", expires, now.toISOString());
db.prepare("INSERT OR REPLACE INTO app_state (key,value,updated_at) VALUES (?,?,?)").run("setup.code_attempts", "0", now.toISOString());

const filePath = path.join(dataDir, "setup-code.txt");
const qrPayload = JSON.stringify({ v: 1, type: "dbhub-setup", code });
try { fs.writeFileSync(filePath, code + "\n" + "DBHUB_SETUP_QR=" + qrPayload + "\n", { mode: 0o600 }); } catch {}

db.close();

console.log("DBHub one-time setup code: " + code);
console.log("DBHUB_SETUP_QR=" + qrPayload);
console.log("Expires: " + expires);
console.log("Also written to: " + filePath);
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import platformPaths from "../src/platform/paths-impl.cjs";

function resolveConfigPath() {
  for (const p of platformPaths.configCandidates()) {
    try { if (fs.existsSync(p)) return path.resolve(p); } catch {}
  }
  throw new Error("Config file not found.");
}

const configPath = resolveConfigPath();
const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const token = `fzh_${crypto.randomBytes(32).toString("base64url")}`;
const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
raw.adminTokenHash = hash;

// backup
const stamp = Date.now();
const backupPath = `${configPath}.bak-${stamp}`;
fs.copyFileSync(configPath, backupPath);

// atomic write
const tmp = `${configPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
const content = JSON.stringify(raw, null, 2) + "\n";
const fd = fs.openSync(tmp, "w");
fs.writeFileSync(fd, content);
fs.fsyncSync(fd);
fs.closeSync(fd);
fs.renameSync(tmp, configPath);

// prune config backups to 10
const dir = path.dirname(configPath);
const base = path.basename(configPath);
const backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`)).map((f) => path.join(dir, f))
  .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
while (backups.length > 10) {
  const old = backups.shift();
  if (old) try { fs.unlinkSync(old); } catch {}
}

console.log(`Config updated: ${configPath}`);
console.log(`Backup: ${backupPath}`);
console.log(`Admin token (shown once): ${token}`);
console.log("A running service must restart to pick up the CLI change.");

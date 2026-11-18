import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const target = process.env.DBHUB_CONFIG || process.argv[2] || path.resolve(process.cwd(), "config.json");
const companyId = `cmp_${crypto.randomUUID()}`;
const replicaId = `hub_${crypto.randomUUID()}`;
const adminToken = `fzh_${crypto.randomBytes(32).toString("base64url")}`;
const adminTokenHash = crypto.createHash("sha256").update(adminToken, "utf8").digest("hex");

const config = {
  companyId,
  replicaId,
  port: 8787,
  host: "0.0.0.0",
  adminTokenHash,
  dataDir: path.resolve(process.cwd(), "data"),
  logDir: path.resolve(process.cwd(), "logs"),
  storage: { target: "null", folderPath: "" },
  limits: { maxBodyBytes: 5242880, ratePerMinutePerDevice: 120, ratePerMinutePerIp: 300 },
  quarantine: { pendingParentTimeoutMs: 86400000 },
};

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
console.log(`Config written: ${target}`);
console.log(`Admin token (shown once): ${adminToken}`);
console.log(`Company ID: ${companyId}`);

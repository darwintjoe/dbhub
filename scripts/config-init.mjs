import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import platformPaths from "../src/platform/paths-impl.cjs";

// Keep existing resolution order: DBHUB_CONFIG, explicit arg, then ./config.json.
const target = process.env.DBHUB_CONFIG || process.argv[2] || platformPaths.cwdConfigPath();
const systemConfig = platformPaths.defaultConfigPath();
const writingSystemConfig = path.resolve(target) === path.resolve(systemConfig);

// Local/dev configs keep the existing cwd-relative data and log dirs. When
// writing the platform system config location, use platform defaults instead.
const dataDir = process.env.DBHUB_DATA_DIR
  || (writingSystemConfig ? platformPaths.defaultDataDir() : path.resolve(process.cwd(), "data"));
const logDir = process.env.DBHUB_LOG_DIR
  || (writingSystemConfig ? platformPaths.defaultLogDir() : path.resolve(process.cwd(), "logs"));

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
  dataDir,
  logDir,
  storage: { target: "null", folderPath: "" },
  limits: { maxBodyBytes: 5242880, ratePerMinutePerDevice: 120, ratePerMinutePerIp: 300, ratePerMinutePerAdmin: 600 },
  quarantine: { pendingParentTimeoutMs: 86400000 },
  publicUrl: "",
  monitoring: { enabled: true, sampleIntervalMs: 5000, historyPoints: 120, hostCounters: true },
  backup: { dir: "", retentionDays: 14, maxFiles: 20 },
  security: { trustProxy: false, adminAllowedCidrs: [] },
};

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
console.log(`Config written: ${target}`);
console.log(`Admin token (shown once): ${adminToken}`);
console.log(`Company ID: ${companyId}`);

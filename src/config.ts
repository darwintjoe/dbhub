import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configCandidates, resolvePath, type PathDeps } from "./platform/paths";

const storageSchema = z.object({
  target: z.enum(["null", "folder"]).default("null"),
  folderPath: z.string().default(""),
  // StorageAdapter seam (plan §4.4). "null" preserves legacy behavior.
  adapter: z.enum(["null", "memory", "local-folder"]).default("null"),
});

const limitsSchema = z.object({
  maxBodyBytes: z.number().int().positive().default(5242880),
  ratePerMinutePerDevice: z.number().int().positive().default(120),
  ratePerMinutePerIp: z.number().int().positive().default(300),
  ratePerMinutePerAdmin: z.number().int().positive().default(600),
});

const quarantineSchema = z.object({
  pendingParentTimeoutMs: z.number().int().positive().default(86400000),
});

const monitoringSchema = z.object({
  enabled: z.boolean().default(true),
  sampleIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  historyPoints: z.number().int().min(30).max(720).default(120),
  hostCounters: z.boolean().default(true),
});

const backupSchema = z.object({
  dir: z.string().default(""),
  retentionDays: z.number().int().positive().default(14),
  maxFiles: z.number().int().positive().default(20),
});

const cloudflareSchema = z.object({
  binaryPath: z.string().default("cloudflared"),
  tunnelTokenFile: z.string().default(""),
  autoStart: z.boolean().default(false),
});

const connectivitySchema = z.object({
  mode: z.enum(["lan", "cloudflare"]).default("lan"),
  publicUrl: z.string().default(""),
  publicDomain: z.string().default("hub.example.com"),
  publicPort: z.number().int().min(1).max(65535).default(8788),
  cloudflare: cloudflareSchema.default({ binaryPath: "cloudflared", tunnelTokenFile: "", autoStart: false }),
  mdns: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
});

const securitySchema = z.object({
  trustProxy: z.union([z.boolean(), z.number().int().nonnegative(), z.string()]).default(false),
  adminAllowedCidrs: z.array(z.string()).default([]),
  allowedOrigins: z.array(z.string()).default([]),
});

export const configSchema = z.object({
  companyId: z.string().min(1),
  replicaId: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(8787),
  host: z.string().min(1).default("0.0.0.0"),
  adminTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  dataDir: z.string().min(1),
  logDir: z.string().min(1),
  publicUrl: z.string().default(""),
  storage: storageSchema.default({ target: "null", folderPath: "", adapter: "null" }),
  limits: limitsSchema.default({
    maxBodyBytes: 5242880,
    ratePerMinutePerDevice: 120,
    ratePerMinutePerIp: 300,
    ratePerMinutePerAdmin: 600,
  }),
  quarantine: quarantineSchema.default({ pendingParentTimeoutMs: 86400000 }),
  monitoring: monitoringSchema.default({
    enabled: true,
    sampleIntervalMs: 5000,
    historyPoints: 120,
    hostCounters: true,
  }),
  backup: backupSchema.default({ dir: "", retentionDays: 14, maxFiles: 20 }),
  connectivity: connectivitySchema.default({
    mode: "lan",
    publicUrl: "",
    publicDomain: "hub.example.com",
    publicPort: 8788,
    cloudflare: { binaryPath: "cloudflared", tunnelTokenFile: "", autoStart: false },
    mdns: { enabled: true },
  }),
  security: securitySchema.default({ trustProxy: false, adminAllowedCidrs: [], allowedOrigins: [] }),
});

export type Config = z.infer<typeof configSchema>;

export function resolveConfigPath(deps?: PathDeps): string {
  for (const p of configCandidates(deps)) {
    try {
      if (fs.existsSync(p)) return resolvePath(p, deps);
    } catch {
      // ignore
    }
  }
  throw new Error(
    "Config file not found. Set DBHUB_CONFIG or create ./config.json. Run `npm run config:init`.",
  );
}

export function loadConfig(deps?: PathDeps): { config: Config; path: string } {
  const p = resolveConfigPath(deps);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`Failed to read/parse config at ${p}: ${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${p}: ${JSON.stringify(parsed.error.flatten())}`);
  }
  const config = parsed.data;
  if (!path.isAbsolute(config.dataDir)) config.dataDir = path.resolve(path.dirname(p), config.dataDir);
  if (!path.isAbsolute(config.logDir)) config.logDir = path.resolve(path.dirname(p), config.logDir);
  if (config.backup.dir && !path.isAbsolute(config.backup.dir)) config.backup.dir = path.resolve(path.dirname(p), config.backup.dir);
  if (config.storage.target === "folder" && config.storage.folderPath && !path.isAbsolute(config.storage.folderPath)) config.storage.folderPath = path.resolve(path.dirname(p), config.storage.folderPath);
  config.replicaId = sanitizeSerial(config.replicaId);
  return { config, path: p };
}

export function sanitizeSerial(serial: string): string {
  let s = String(serial).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) s = "dbhub";
  return s.slice(0, 63);
}

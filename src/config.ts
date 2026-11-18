import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const storageSchema = z.object({
  target: z.enum(["null", "folder", "s3", "drive"]).default("null"),
  folderPath: z.string().default(""),
});

const limitsSchema = z.object({
  maxBodyBytes: z.number().int().positive().default(5242880),
  ratePerMinutePerDevice: z.number().int().positive().default(120),
  ratePerMinutePerIp: z.number().int().positive().default(300),
});

const quarantineSchema = z.object({
  pendingParentTimeoutMs: z.number().int().positive().default(86400000),
});

export const configSchema = z.object({
  companyId: z.string().min(1),
  replicaId: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(8787),
  host: z.string().min(1).default("0.0.0.0"),
  adminTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  dataDir: z.string().min(1),
  logDir: z.string().min(1),
  storage: storageSchema.default({ target: "null", folderPath: "" }),
  limits: limitsSchema.default({
    maxBodyBytes: 5242880,
    ratePerMinutePerDevice: 120,
    ratePerMinutePerIp: 300,
  }),
  quarantine: quarantineSchema.default({ pendingParentTimeoutMs: 86400000 }),
});

export type Config = z.infer<typeof configSchema>;

function candidatePaths(): string[] {
  const out: string[] = [];
  if (process.env.FAZAI_HUB_CONFIG) out.push(process.env.FAZAI_HUB_CONFIG);
  const programData = process.env.PROGRAMDATA || "C:\\ProgramData";
  out.push(path.join(programData, "FazaiHub", "config.json"));
  out.push(path.resolve(process.cwd(), "config.json"));
  return out;
}

export function resolveConfigPath(): string {
  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) return path.resolve(p);
    } catch {
      // ignore
    }
  }
  throw new Error(
    "Config file not found. Set FAZAI_HUB_CONFIG or create ./config.json. Run `npm run config:init`.",
  );
}

export function loadConfig(): { config: Config; path: string } {
  const p = resolveConfigPath();
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
  return { config, path: p };
}

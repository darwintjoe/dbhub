import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type { Config } from "../config";
import { configSchema, loadConfig, resolveConfigPath } from "../config";
import { ApiError } from "../http/errors";
import type { AuditRepo } from "../db/audit.repo";

export interface ConfigSaveResult {
  ok: boolean;
  hash: string;
  hotApplied: string[];
  restartRequired: string[];
  backupPath: string;
}

const HOT_FIELDS = new Set([
  "limits.ratePerMinutePerDevice",
  "limits.ratePerMinutePerIp",
  "limits.ratePerMinutePerAdmin",
  "quarantine.pendingParentTimeoutMs",
  "monitoring.enabled",
  "monitoring.sampleIntervalMs",
  "monitoring.historyPoints",
  "monitoring.hostCounters",
  "backup.dir",
  "backup.retentionDays",
  "backup.maxFiles",
  "security.adminAllowedCidrs",
  "publicUrl",
  "connectivity.mdns.enabled",
  "connectivity.cloudflare.autoStart",
  "adminTokenHash",
]);

const RESTART_FIELDS = new Set([
  "companyId",
  "replicaId",
  "port",
  "host",
  "dataDir",
  "logDir",
  "storage.target",
  "storage.folderPath",
  "limits.maxBodyBytes",
  "security.trustProxy",
  "connectivity.mode",
  "connectivity.publicUrl",
  "connectivity.publicPort",
  "connectivity.cloudflare.binaryPath",
  "connectivity.cloudflare.tunnelTokenFile",
]);

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenKeys(v, key));
    } else {
      out.push(key);
    }
  }
  return out;
}

function getAtPath(obj: unknown, p: string): unknown {
  return p.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function setAtPath(obj: Record<string, unknown>, p: string, value: unknown): void {
  const parts = p.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!cur[part] || typeof cur[part] !== "object" || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function validatePathField(value: string, configDir: string, name: string, create: boolean): string {
  if (value.includes("\0")) throw new ApiError(400, "CONFIG-001", `${name} contains a null byte.`);
  if (!value) throw new ApiError(400, "CONFIG-001", `${name} is required.`);
  const resolved = path.isAbsolute(value) ? value : path.resolve(configDir, value);
  if (create) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (e) {
      throw new ApiError(400, "CONFIG-001", `${name} is not creatable: ${(e as Error).message}`);
    }
  }
  try {
    if (create) {
      const probe = path.join(resolved, `.dbhub-probe-${process.pid}`);
      fs.writeFileSync(probe, "x");
      fs.unlinkSync(probe);
    } else if (!fs.existsSync(resolved)) {
      throw new Error("does not exist");
    }
  } catch (e) {
    throw new ApiError(400, "CONFIG-001", `${name} is not writable: ${(e as Error).message}`);
  }
  return resolved;
}

export class ConfigService {
  private readonly configPath: string;
  private readonly configDir: string;
  private config: Config;
  private raw: Record<string, unknown>;
  private initialHash: string;
  private writeLock: Promise<unknown> = Promise.resolve();
  private readonly audit: AuditRepo | undefined;

  constructor(opts: { path?: string; config?: Config; raw?: Record<string, unknown>; audit?: AuditRepo } = {}) {
    this.configPath = opts.path ?? resolveConfigPath();
    const loaded = opts.config ? { config: opts.config, path: this.configPath } : loadConfig();
    this.config = loaded.config;
    this.configPath = loaded.path;
    this.configDir = path.dirname(this.configPath);
    try {
      this.raw = opts.raw ?? (JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Record<string, unknown>);
    } catch {
      this.raw = {};
    }
    this.initialHash = sha256File(this.configPath);
    this.audit = opts.audit;
  }

  static load(audit?: AuditRepo): ConfigService {
    const { config, path } = loadConfig();
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const opts: any = { path, config, raw };
    if (audit) opts.audit = audit;
    return new ConfigService(opts);
  }

  getPath(): string {
    return this.configPath;
  }

  getConfig(): Config {
    return this.config;
  }

  getRaw(): Record<string, unknown> {
    return this.raw;
  }

  getHash(): string {
    return sha256File(this.configPath);
  }

  getInitialHash(): string {
    return this.initialHash;
  }

  markLoaded(): void {
    this.initialHash = sha256File(this.configPath);
  }

  getRedactedConfig(): Record<string, unknown> {
    const out = JSON.parse(JSON.stringify(this.raw)) as Record<string, unknown>;
    // ensure known fields reflect live config
    for (const key of flattenKeys(this.config as unknown as Record<string, unknown>)) {
      const v = getAtPath(this.config, key);
      if (key !== "adminTokenHash") setAtPath(out, key, v);
    }
    out.adminTokenHash = { configured: Boolean(this.config.adminTokenHash), value: "********" };
    return out;
  }

  private normalizeIncomingConfig(input: unknown): { config: Config; rawMerged: Record<string, unknown> } {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ApiError(400, "CONFIG-001", "Config must be an object.");
    }
    const incoming = input as Record<string, unknown>;
    // preserve adminTokenHash if redacted/omitted
    const mergedRaw = JSON.parse(JSON.stringify(this.raw)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(incoming)) {
      if (k === "adminTokenHash") {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const obj = v as Record<string, unknown>;
          if (obj.value === "********" || obj.configured !== undefined) continue;
        }
        if (v === "********") continue;
      }
      mergedRaw[k] = v;
    }
    // nested merge for known sections
    const parsed = configSchema.safeParse(mergedRaw);
    if (!parsed.success) {
      throw new ApiError(400, "CONFIG-001", "Invalid config.", { details: parsed.error.flatten() });
    }
    const config = parsed.data;
    // resolve relative paths
    if (!path.isAbsolute(config.dataDir)) config.dataDir = path.resolve(this.configDir, config.dataDir);
    if (!path.isAbsolute(config.logDir)) config.logDir = path.resolve(this.configDir, config.logDir);
    if (config.backup.dir && !path.isAbsolute(config.backup.dir)) config.backup.dir = path.resolve(this.configDir, config.backup.dir);
    if (config.storage.target === "folder" && config.storage.folderPath && !path.isAbsolute(config.storage.folderPath)) config.storage.folderPath = path.resolve(this.configDir, config.storage.folderPath);

    // validate writable paths
    validatePathField(config.dataDir, this.configDir, "dataDir", true);
    validatePathField(config.logDir, this.configDir, "logDir", true);
    if (config.storage.target === "folder" && config.storage.folderPath) {
      validatePathField(config.storage.folderPath, this.configDir, "storage.folderPath", true);
    }
    if (config.backup.dir) {
      validatePathField(config.backup.dir, this.configDir, "backup.dir", true);
    }
    // null bytes anywhere
    const rawStr = JSON.stringify(mergedRaw);
    if (rawStr.includes("\u0000")) throw new ApiError(400, "CONFIG-001", "Config contains a null byte.");

    return { config, rawMerged: mergedRaw };
  }

  async validate(input: unknown): Promise<{ ok: boolean; errors?: unknown; config?: Config }> {
    try {
      const { config } = this.normalizeIncomingConfig(input);
      return { ok: true, config };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, errors: e.details ?? e.message };
      return { ok: false, errors: (e as Error).message };
    }
  }

  async save(opts: { config: unknown; baseHash?: string; force?: boolean }): Promise<ConfigSaveResult> {
    const run = async (): Promise<ConfigSaveResult> => {
      const currentHash = sha256File(this.configPath);
      if (opts.baseHash && opts.baseHash !== currentHash && !opts.force) {
        throw new ApiError(409, "CONFIG-002", "Config changed on disk; reload and retry.");
      }
      const { config: newConfig, rawMerged } = this.normalizeIncomingConfig(opts.config);

      // changed fields
      const changed: string[] = [];
      const allKeys = new Set([...flattenKeys(this.config as unknown as Record<string, unknown>), ...flattenKeys(newConfig as unknown as Record<string, unknown>)]);
      for (const key of allKeys) {
        const a = JSON.stringify(getAtPath(this.config, key));
        const b = JSON.stringify(getAtPath(newConfig, key));
        if (a !== b) changed.push(key);
      }
      const hotApplied = changed.filter((k) => HOT_FIELDS.has(k));
      const restartRequired = changed.filter((k) => RESTART_FIELDS.has(k));

      // backup current
      const backupPath = await this.createBackupFile();

      // atomic write
      const tmp = `${this.configPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      const content = JSON.stringify(rawMerged, null, 2) + "\n";
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.configPath);

      // retain backups
      this.pruneBackups();

      // update raw only; apply hot fields to live config
      this.raw = rawMerged;
      for (const key of changed) {
        if (HOT_FIELDS.has(key)) {
          setAtPath(this.config as unknown as Record<string, unknown>, key, getAtPath(newConfig, key));
        }
      }
      this.initialHash = sha256File(this.configPath);
      // hot-apply only hot fields? We mutated all; restart fields flagged. Fine.

      const newHash = sha256File(this.configPath);
      // audit
      if (this.audit) {
        this.audit.log(new Date().toISOString(), "admin", "config.saved", {
          changed,
          hotApplied,
          restartRequired,
          backupPath,
        });
      }
      return { ok: true, hash: newHash, hotApplied, restartRequired, backupPath };
    };

    const p = this.writeLock.then(run, run);
    this.writeLock = p.catch(() => undefined) as Promise<unknown>;
    return p as Promise<ConfigSaveResult>;
  }

  async createBackupFile(): Promise<string> {
    const stamp = `${Date.now()}`;
    let backupPath = `${this.configPath}.bak-${stamp}`;
    let n = 0;
    while (fs.existsSync(backupPath)) {
      n++;
      backupPath = `${this.configPath}.bak-${stamp}-${n}`;
    }
    fs.copyFileSync(this.configPath, backupPath);
    return backupPath;
  }

  private pruneBackups(): void {
    const dir = path.dirname(this.configPath);
    const base = path.basename(this.configPath);
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-`))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    while (backups.length > 10) {
      const old = backups.shift();
      if (old) {
        try { fs.unlinkSync(old); } catch { /* ignore */ }
      }
    }
  }

  async rotateAdminToken(auditActor = "admin", ip?: string, userAgent?: string): Promise<{ token: string }> {
    const run = async (): Promise<{ token: string }> => {
      const token = `fzh_${crypto.randomBytes(32).toString("base64url")}`;
      const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
      const newConfig = JSON.parse(JSON.stringify(this.config)) as Record<string, unknown>;
      newConfig.adminTokenHash = hash;
      // save with force
      await this.save({ config: newConfig, force: true });
      (this.config as unknown as Record<string, unknown>).adminTokenHash = hash;
      this.raw.adminTokenHash = hash;
      if (this.audit) {
        this.audit.log(new Date().toISOString(), auditActor, "config.rotate-admin-token", {
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }
      return { token };
    };
    const p = this.writeLock.then(run, run);
    this.writeLock = p.catch(() => undefined) as Promise<unknown>;
    return p as Promise<{ token: string }>;
  }

  redactAdminTokenHash<T extends Record<string, unknown>>(obj: T): T {
    const clone = JSON.parse(JSON.stringify(obj)) as T;
    (clone as Record<string, unknown>).adminTokenHash = { configured: true, value: "********" };
    return clone;
  }
}

export function redactConfig(config: Config): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  out.adminTokenHash = { configured: Boolean((config as { adminTokenHash?: string }).adminTokenHash), value: "********" };
  return out;
}
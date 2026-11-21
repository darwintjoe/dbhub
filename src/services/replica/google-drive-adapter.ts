import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { StorageObjectNotFoundError, type PausableStorageAdapter, type StorageObjectRef } from "./storage-adapter";

/** PRD §13: drive.file only, appDataFolder only. No other scope is accepted. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const APP_DATA_FOLDER = "appDataFolder";
const RECONNECT_MESSAGE = "Please reconnect your Google account to continue backup.";

export class GoogleDriveRevokedError extends Error {
  readonly code = "DRIVE-REVOKED";
  constructor() {
    super(RECONNECT_MESSAGE);
    this.name = "GoogleDriveRevokedError";
  }
}

export interface TokenSet {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

export interface GoogleTokenStore {
  read(): Promise<TokenSet>;
  write(tokens: TokenSet): Promise<void>;
}

/** Token file at rest with mode 0600 on POSIX. Content is never logged. */
export class FileTokenStore implements GoogleTokenStore {
  constructor(private readonly filePath: string) {
    if (!filePath) throw new Error("Google token path is required.");
  }

  async read(): Promise<TokenSet> {
    if (process.platform !== "win32") {
      const st = await fs.stat(this.filePath);
      if ((st.mode & 0o077) !== 0) throw new Error("DRIVE-MODE: token file must be mode 0600.");
    }
    return JSON.parse(await fs.readFile(this.filePath, "utf8")) as TokenSet;
  }

  async write(tokens: TokenSet): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(this.filePath, 0o600);
  }
}

export interface DriveFile {
  id: string;
  name: string;
}

/** Minimal seam so tests can drive a fake Google API without credentials. */
export interface GoogleDriveApi {
  listFiles(name?: string): Promise<DriveFile[]>;
  createFile(name: string, bytes: Uint8Array): Promise<DriveFile>;
  downloadFile(id: string): Promise<Uint8Array>;
  deleteFile(id: string): Promise<void>;
  refreshAccessToken(): Promise<TokenSet>;
}

class GoogleApiClient implements GoogleDriveApi {
  private readonly oauth: InstanceType<typeof google.auth.OAuth2>;
  private readonly drive: drive_v3.Drive;

  constructor(clientId: string, tokens: TokenSet) {
    // Scope allowlist is enforced by the adapter constructor; the token was
    // issued with drive.file only, so no broader scope is ever requested here.
    this.oauth = new google.auth.OAuth2({ clientId });
    this.oauth.setCredentials(tokens as any);
    this.drive = google.drive({ version: "v3", auth: this.oauth });
  }

  async listFiles(name?: string): Promise<DriveFile[]> {
    const escaped = name?.replace(/'/g, "\\'");
    const q = `'${APP_DATA_FOLDER}' in parents and trashed=false${escaped ? ` and name='${escaped}'` : ""}`;
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q,
        spaces: APP_DATA_FOLDER,
        pageSize: 1000,
        fields: "nextPageToken, files(id,name)",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const f of res.data.files ?? []) {
        if (f.id && f.name) files.push({ id: f.id, name: f.name });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  }

  async createFile(name: string, bytes: Uint8Array): Promise<DriveFile> {
    const res = await this.drive.files.create({
      requestBody: { name, parents: [APP_DATA_FOLDER] },
      media: { body: Readable.from([Buffer.from(bytes)]) },
      fields: "id,name",
    });
    return { id: String(res.data.id), name: String(res.data.name ?? name) };
  }

  async downloadFile(id: string): Promise<Uint8Array> {
    const res = await this.drive.files.get({ fileId: id, alt: "media" }, { responseType: "arraybuffer" });
    return new Uint8Array(res.data as ArrayBuffer);
  }

  async deleteFile(id: string): Promise<void> {
    await this.drive.files.delete({ fileId: id });
  }

  async refreshAccessToken(): Promise<TokenSet> {
    const { credentials } = await this.oauth.refreshAccessToken();
    this.oauth.setCredentials(credentials);
    return credentials as TokenSet;
  }
}

export function bundleObjectName(key: string): string {
  const base = key.endsWith(".json") ? key.slice(0, -5) : key;
  const match = /^b-(\d+)-(.+)$/.exec(base);
  if (match) return `b-${match[1]!.padStart(10, "0")}-${match[2]}.json`;
  return `b-${"0".repeat(10)}-${base}.json`;
}

export function snapshotObjectName(id: string): string {
  const base = id.endsWith(".json") ? id.slice(0, -5) : id;
  return `${base.startsWith("snap-") ? base : `snap-${base}`}.json`;
}

export function closingPackObjectName(period: string): string {
  const base = period.endsWith(".json") ? period.slice(0, -5) : period;
  return `${base.startsWith("close-") ? base : `close-${base}`}.json`;
}

export function manifestObjectName(replicaId: string): string {
  return `manifest-${replicaId}.json`;
}

interface Failure {
  status?: number | undefined;
  code?: string | undefined;
}

function failure(e: unknown): Failure {
  if (!e || typeof e !== "object") return {};
  const obj = e as Record<string, unknown>;
  const response = obj.response as Record<string, unknown> | undefined;
  const status = typeof obj.status === "number"
    ? obj.status
    : typeof response?.status === "number" ? response.status : undefined;
  const code = typeof obj.code === "string" ? obj.code : undefined;
  return { status, code };
}

function isAuthFailure(f: Failure): boolean {
  const code = (f.code ?? "").toLowerCase();
  return f.status === 401 || (f.status === 403 && /invalid_grant|revok/.test(code));
}

function isRetryable(f: Failure): boolean {
  if (f.status === 429 || f.status === 500 || f.status === 502 || f.status === 503 || f.status === 504) return true;
  return /ratelimit/.test(f.code ?? "");
}

export interface GoogleDriveAdapterOptions {
  clientId: string;
  companyId: string;
  replicaId: string;
  tokenStore: GoogleTokenStore;
  scopes?: string[] | undefined;
  api?: GoogleDriveApi | undefined;
  baseDelayMs?: number | undefined;
  maxAttempts?: number | undefined;
  maxDelayMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Drive Adapter (PRD §13/§14). Opt-in via config; memory/local-folder remain
 * the defaults. Calls are serialized per company and retried with backoff.
 */
export class GoogleDriveAdapter implements PausableStorageAdapter {
  readonly name = "google-drive";
  private readonly clientId: string;
  private readonly replicaId: string;
  private readonly tokenStore: GoogleTokenStore;
  private readonly baseDelayMs: number;
  private readonly maxAttempts: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private api: GoogleDriveApi | null;
  private tokens: TokenSet = {};
  private queue: Promise<unknown> = Promise.resolve();
  private paused = false;

  constructor(opts: GoogleDriveAdapterOptions) {
    this.clientId = opts.clientId;
    this.replicaId = opts.replicaId;
    this.tokenStore = opts.tokenStore;
    this.api = opts.api ?? null;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const scope of opts.scopes ?? [DRIVE_FILE_SCOPE]) {
      if (scope !== DRIVE_FILE_SCOPE) throw new Error("DRIVE-SCOPE: drive.file is the only allowed scope.");
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  driveStatus(): { revoked: boolean; message: string; action: string } {
    return this.paused
      ? { revoked: true, message: RECONNECT_MESSAGE, action: "Reconnect Google Drive" }
      : { revoked: false, message: "Storage connection is working.", action: "None" };
  }

  private getApi(): GoogleDriveApi {
    if (!this.api) throw new Error("DRIVE-001: adapter is not connected.");
    return this.api;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        const f = failure(e);
        if (isAuthFailure(f)) {
          this.paused = true;
          throw new GoogleDriveRevokedError();
        }
        if (isRetryable(f) && attempt < this.maxAttempts) {
          const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
          await this.sleep(delay);
          attempt++;
          continue;
        }
        throw e;
      }
    }
  }

  private async ensureToken(): Promise<void> {
    const tokens = await this.tokenStore.read();
    if (tokens.expiry_date && tokens.expiry_date <= Date.now() + 60_000) {
      const refreshed = await this.serialize(() => this.withRetry(() => this.getApi().refreshAccessToken()));
      const next = { ...tokens, ...refreshed };
      await this.tokenStore.write(next);
      this.tokens = next;
    } else {
      this.tokens = tokens;
    }
  }

  private async call<T>(fn: (api: GoogleDriveApi) => Promise<T>): Promise<T> {
    if (this.paused) throw new GoogleDriveRevokedError();
    await this.ensureToken();
    return this.serialize(() => this.withRetry(() => fn(this.getApi())));
  }

  private async find(name: string): Promise<DriveFile | undefined> {
    const files = await this.call((api) => api.listFiles(name));
    return files[0];
  }

  async connect(_auth: unknown): Promise<void> {
    if (!this.api) {
      const tokens = await this.tokenStore.read();
      this.api = new GoogleApiClient(this.clientId, tokens);
    }
    await this.ensureToken();
  }

  async disconnect(): Promise<void> {
    // No persistent handle; paused state remains until reconnect.
  }

  async healthCheck(): Promise<boolean> {
    if (this.paused) return false;
    try {
      await this.call((api) => api.listFiles());
      return true;
    } catch {
      return false;
    }
  }

  async uploadBundle(key: string, bytes: Uint8Array): Promise<{ uri: string }> {
    const file = await this.call((api) => api.createFile(bundleObjectName(key), bytes));
    return { uri: `gdrive://${file.id}` };
  }

  async downloadBundle(key: string): Promise<Uint8Array> {
    const file = await this.find(bundleObjectName(key));
    if (!file) throw new StorageObjectNotFoundError("bundle", key);
    return this.call((api) => api.downloadFile(file.id));
  }

  async listBundles(fromKey?: string): Promise<StorageObjectRef[]> {
    const files = await this.call((api) => api.listFiles());
    return files
      .filter((f) => /^b-\d{10}-.+\.json$/.test(f.name))
      .filter((f) => fromKey === undefined || f.name > fromKey)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => ({ key: f.name, uri: `gdrive://${f.id}` }));
  }

  async deleteBundle(key: string): Promise<void> {
    const file = await this.find(bundleObjectName(key));
    if (!file) return;
    await this.call((api) => api.deleteFile(file.id));
  }

  async uploadSnapshot(id: string, bytes: Uint8Array): Promise<{ uri: string }> {
    const file = await this.call((api) => api.createFile(snapshotObjectName(id), bytes));
    return { uri: `gdrive://${file.id}` };
  }

  async downloadSnapshot(id: string): Promise<Uint8Array> {
    const file = await this.find(snapshotObjectName(id));
    if (!file) throw new StorageObjectNotFoundError("snapshot", id);
    return this.call((api) => api.downloadFile(file.id));
  }

  async uploadClosingPack(period: string, bytes: Uint8Array): Promise<{ uri: string }> {
    const file = await this.call((api) => api.createFile(closingPackObjectName(period), bytes));
    return { uri: `gdrive://${file.id}` };
  }

  async downloadClosingPack(period: string): Promise<Uint8Array> {
    const file = await this.find(closingPackObjectName(period));
    if (!file) throw new StorageObjectNotFoundError("closing-pack", period);
    return this.call((api) => api.downloadFile(file.id));
  }

  async uploadManifest(json: string): Promise<{ uri: string }> {
    const file = await this.call((api) => api.createFile(manifestObjectName(this.replicaId), Buffer.from(json)));
    return { uri: `gdrive://${file.id}` };
  }

  async getManifest(): Promise<string | null> {
    const file = await this.find(manifestObjectName(this.replicaId));
    if (!file) return null;
    return Buffer.from(await this.call((api) => api.downloadFile(file.id))).toString("utf8");
  }
}

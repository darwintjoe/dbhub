import type {
  DriveFile,
  GoogleDriveApi,
  GoogleTokenStore,
  TokenSet,
} from "../../src/services/replica/google-drive-adapter";

export class MemoryTokenStore implements GoogleTokenStore {
  writes = 0;
  private tokens: TokenSet;

  constructor(tokens: TokenSet) {
    this.tokens = { ...tokens };
  }

  async read(): Promise<TokenSet> {
    return { ...this.tokens };
  }

  async write(tokens: TokenSet): Promise<void> {
    this.writes++;
    this.tokens = { ...tokens };
  }
}

export interface FakeDriveOptions {
  failCalls?: number | undefined;
  revokeOnCall?: boolean | undefined;
}

/** Fake Google API: no credentials, no network, deterministic failure modes. */
export class FakeGoogleDriveApi implements GoogleDriveApi {
  readonly files = new Map<string, { name: string; bytes: Uint8Array }>();
  readonly calls: string[] = [];
  refreshCount = 0;
  revokeOnCall: boolean;

  private nextId = 1;
  private failsLeft: number;

  constructor(opts: FakeDriveOptions = {}) {
    this.failsLeft = opts.failCalls ?? 0;
    this.revokeOnCall = opts.revokeOnCall ?? false;
  }

  private gate(): void {
    this.calls.push("call");
    if (this.revokeOnCall) throw { status: 401, code: "invalid_grant" };
    if (this.failsLeft > 0) {
      this.failsLeft--;
      throw { status: 429, code: "rateLimitExceeded" };
    }
  }

  async listFiles(name?: string): Promise<DriveFile[]> {
    this.gate();
    return [...this.files.entries()]
      .filter(([, f]) => !name || f.name === name)
      .map(([id, f]) => ({ id, name: f.name }));
  }

  async createFile(name: string, bytes: Uint8Array): Promise<DriveFile> {
    this.gate();
    const id = `file_${this.nextId++}`;
    this.files.set(id, { name, bytes: Uint8Array.from(bytes) });
    return { id, name };
  }

  async downloadFile(id: string): Promise<Uint8Array> {
    this.gate();
    const file = this.files.get(id);
    if (!file) throw { status: 404 };
    return Uint8Array.from(file.bytes);
  }

  async deleteFile(id: string): Promise<void> {
    this.gate();
    this.files.delete(id);
  }

  async refreshAccessToken(): Promise<TokenSet> {
    this.refreshCount++;
    if (this.revokeOnCall) throw { status: 401, code: "invalid_grant" };
    return { access_token: "fresh-token", expiry_date: Date.now() + 3_600_000 };
  }
}

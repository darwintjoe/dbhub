import fs from "node:fs/promises";
import { tokenHash } from "../../domain/hashing";
import type {
  BlockIssueRequest,
  DelegatedBlock,
  NumberDelegationClient,
  ReconcileRequest,
} from "../numbers/number-block-client";

/**
 * SaaS sequencer client (PRD §15.3 correction, plan §4.2).
 *
 * Only metadata crosses the Hub -> SaaS boundary. There is deliberately no
 * payload field on SequenceMetadata: SaaS never fetches or stores bundle
 * contents. Upload to replica storage happens before sequencing.
 */

export type SaasProfile = "solo" | "hub_required";

export interface SequenceMetadata {
  bundleId: string;
  prevHash: string | null;
  payloadHash: string;
  driveUri: string;
  eventCount: number;
  deviceId: string;
  hubOrigin: boolean;
}

export interface SequenceResult {
  globalSequenceNo: number;
  globalBundleHash: string;
  sequencedAt: string;
}

export interface SequencerClient {
  readonly name: string;
  sequence(metadata: SequenceMetadata): Promise<SequenceResult>;
}

/** Same machine-token client serves sequencing and delegated numbers. */
export type SaasClient = SequencerClient & NumberDelegationClient;

export class SaasSequencingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SaasSequencingError";
    this.code = code;
  }
}

/** PRD §10.3: Profile B accepts only Hub-originated sequencing. */
export function assertHubOriginAllowed(profile: SaasProfile, hubOrigin: boolean): void {
  if (profile === "hub_required" && hubOrigin !== true) {
    throw new SaasSequencingError(
      "SAAS-003",
      "Profile B rejects sequencing that is not relayed through Hub.",
    );
  }
}

/** Machine tokens are opaque in transit; only their hash may be kept at rest. */
export function hashDeviceToken(token: string): string {
  return tokenHash(token);
}

export interface DeviceTokenProvider {
  getToken(): Promise<string>;
}

export class MemoryDeviceTokenProvider implements DeviceTokenProvider {
  constructor(private readonly token: string) {}

  async getToken(): Promise<string> {
    if (!this.token) throw new SaasSequencingError("SAAS-001", "SaaS device token not configured.");
    return this.token;
  }

  hashedToken(): string {
    return hashDeviceToken(this.token);
  }
}

/** Reads a dedicated token file; POSIX mode must be 0600. Never logs content. */
export class FileDeviceTokenProvider implements DeviceTokenProvider {
  constructor(private readonly filePath: string) {
    if (!filePath) throw new SaasSequencingError("SAAS-001", "SaaS token file not configured.");
  }

  async getToken(): Promise<string> {
    if (process.platform !== "win32") {
      const st = await fs.stat(this.filePath);
      if ((st.mode & 0o077) !== 0) {
        throw new SaasSequencingError("SAAS-005", "SaaS token file must be mode 0600.");
      }
    }
    const token = (await fs.readFile(this.filePath, "utf8")).trim();
    if (!token) throw new SaasSequencingError("SAAS-001", "SaaS token file is empty.");
    return token;
  }
}

export interface HttpSequencerOptions {
  baseUrl: string;
  profile: SaasProfile;
  hubOrigin: boolean;
  deviceTokenProvider: DeviceTokenProvider;
  timeoutMs?: number | undefined;
  path?: string | undefined;
}

function parseResult(data: unknown): SequenceResult {
  if (!data || typeof data !== "object") {
    throw new SaasSequencingError("SAAS-004", "Invalid SaaS sequence response.");
  }
  const obj = data as Record<string, unknown>;
  const seq = obj.global_sequence_no;
  const hash = obj.global_bundle_hash;
  const at = obj.sequenced_at;
  if (typeof seq !== "number" || !Number.isInteger(seq)) {
    throw new SaasSequencingError("SAAS-004", "Invalid SaaS sequence response: global_sequence_no.");
  }
  if (typeof hash !== "string" || !hash) {
    throw new SaasSequencingError("SAAS-004", "Invalid SaaS sequence response: global_bundle_hash.");
  }
  if (typeof at !== "string" || !at) {
    throw new SaasSequencingError("SAAS-004", "Invalid SaaS sequence response: sequenced_at.");
  }
  return { globalSequenceNo: seq, globalBundleHash: hash, sequencedAt: at };
}

export class HttpSequencerClient implements SequencerClient, NumberDelegationClient {
  readonly name = "saas-http";
  private readonly baseUrl: string;
  private readonly profile: SaasProfile;
  private readonly hubOrigin: boolean;
  private readonly tokens: DeviceTokenProvider;
  private readonly timeoutMs: number;
  private readonly path: string;

  constructor(opts: HttpSequencerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.profile = opts.profile;
    this.hubOrigin = opts.hubOrigin;
    this.tokens = opts.deviceTokenProvider;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.path = opts.path ?? "/sync/sequence";
  }

  async sequence(metadata: SequenceMetadata): Promise<SequenceResult> {
    if (!this.baseUrl) throw new SaasSequencingError("SAAS-001", "saas.baseUrl not configured.");
    assertHubOriginAllowed(this.profile, this.hubOrigin && metadata.hubOrigin);

    const token = await this.tokens.getToken();
    const body = {
      bundle_id: metadata.bundleId,
      prev_hash: metadata.prevHash,
      payload_hash: metadata.payloadHash,
      drive_uri: metadata.driveUri,
      event_count: metadata.eventCount,
      device_id: metadata.deviceId,
      hub_origin: this.hubOrigin,
    };

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${this.baseUrl}${this.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": metadata.bundleId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SaasSequencingError("SAAS-002", `SaaS sequence request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new SaasSequencingError("SAAS-002", `SaaS sequence rejected: HTTP ${res.status}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new SaasSequencingError("SAAS-004", "Invalid SaaS sequence response.");
    }
    return parseResult(data);
  }

  private async request<T>(method: "GET" | "POST", resource: string, body?: unknown): Promise<T> {
    if (!this.baseUrl) throw new SaasSequencingError("SAAS-001", "saas.baseUrl not configured.");
    const token = await this.tokens.getToken();
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${this.baseUrl}${resource}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SaasSequencingError("SAAS-002", `SaaS request failed: ${(e as Error).message}`);
    }
    if (!res.ok) throw new SaasSequencingError("SAAS-002", `SaaS request rejected: HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new SaasSequencingError("SAAS-004", "Invalid SaaS response.");
    }
  }

  /** Delegated-number interface backed by the same SaaS machine-token client. */
  async issueBlock(req: BlockIssueRequest): Promise<DelegatedBlock> {
    return this.request<DelegatedBlock>("POST", "/numbers/block", {
      doc_type: req.docType,
      prefix: req.prefix,
      size: req.size,
      device_id: req.deviceId,
    });
  }

  async blockStatus(blockId: string): Promise<DelegatedBlock | null> {
    try {
      return await this.request<DelegatedBlock>("GET", `/numbers/block/${encodeURIComponent(blockId)}`);
    } catch (e) {
      if (e instanceof SaasSequencingError && e.code === "SAAS-002") return null;
      throw e;
    }
  }

  async reconcile(req: ReconcileRequest): Promise<void> {
    await this.request("POST", "/numbers/reconcile", {
      block_id: req.blockId,
      consumed: req.consumed,
      voided: req.voided,
    });
  }
}

/** Used when no SaaS base URL is configured: keeps existing behavior intact. */
export class NullSequencerClient implements SequencerClient {
  readonly name = "saas-null";

  async sequence(_metadata: SequenceMetadata): Promise<SequenceResult> {
    throw new SaasSequencingError("SAAS-001", "SaaS sequencing is not configured.");
  }
}

export interface SequencerSettings {
  baseUrl: string;
  profile: SaasProfile;
  hubOrigin: boolean;
  timeoutMs?: number;
  deviceTokenFile?: string;
}

/**
 * Config boundary. No token is invented or stored here: production callers
 * must supply a token file (0600) or inject a memory provider for tests/CI.
 */
export function createSequencerClient(
  settings: SequencerSettings,
  tokens?: DeviceTokenProvider,
): SaasClient | null {
  if (!settings.baseUrl) return null;
  const provider =
    tokens ??
    (settings.deviceTokenFile
      ? new FileDeviceTokenProvider(settings.deviceTokenFile)
      : new MemoryDeviceTokenProvider(""));
  return new HttpSequencerClient({
    baseUrl: settings.baseUrl,
    profile: settings.profile,
    hubOrigin: settings.hubOrigin,
    deviceTokenProvider: provider,
    timeoutMs: settings.timeoutMs,
  });
}

import {
  SaasSequencingError,
  type SaasProfile,
  type SequenceMetadata,
  type SequenceResult,
  type SequencerClient,
} from "../../src/services/saas/sequencer-client";

export interface FakeSaasManifest {
  latestBundleId: string | null;
  latestBundleHash: string | null;
  latestGlobalSequenceNo: number | null;
  latestGlobalBundleHash: string | null;
  updatedAt: string | null;
}

/** In-memory SaaS control plane: idempotent sequence + manifest maintenance. */
export class FakeSequencerClient implements SequencerClient {
  readonly name = "fake-saas";
  readonly requests: SequenceMetadata[] = [];

  private readonly byBundle = new Map<string, SequenceResult>();
  private seq = 0;
  private state: FakeSaasManifest = {
    latestBundleId: null,
    latestBundleHash: null,
    latestGlobalSequenceNo: null,
    latestGlobalBundleHash: null,
    updatedAt: null,
  };

  constructor(private readonly profile: SaasProfile = "solo") {}

  async sequence(metadata: SequenceMetadata): Promise<SequenceResult> {
    this.requests.push({ ...metadata });
    if (this.profile === "hub_required" && metadata.hubOrigin !== true) {
      throw new SaasSequencingError("SAAS-003", "Profile B rejects non-Hub origin.");
    }
    const existing = this.byBundle.get(metadata.bundleId);
    if (existing) return existing;

    this.seq += 1;
    const result: SequenceResult = {
      globalSequenceNo: this.seq,
      globalBundleHash: `g${this.seq.toString(16).padStart(64, "0")}`,
      sequencedAt: new Date().toISOString(),
    };
    this.byBundle.set(metadata.bundleId, result);
    this.state = {
      latestBundleId: metadata.bundleId,
      // SaaS stores metadata only; payload_hash is the only hash it receives.
      latestBundleHash: metadata.payloadHash,
      latestGlobalSequenceNo: result.globalSequenceNo,
      latestGlobalBundleHash: result.globalBundleHash,
      updatedAt: result.sequencedAt,
    };
    return result;
  }

  manifest(): FakeSaasManifest {
    return { ...this.state };
  }

  lastRequest(): SequenceMetadata | undefined {
    return this.requests[this.requests.length - 1];
  }
}

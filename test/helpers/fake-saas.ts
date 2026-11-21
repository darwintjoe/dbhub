import {
  SaasSequencingError,
  type SaasProfile,
  type SequenceMetadata,
  type SequenceResult,
  type SequencerClient,
} from "../../src/services/saas/sequencer-client";
import type {
  BlockIssueRequest,
  DelegatedBlock,
  NumberDelegationClient,
  ReconcileRequest,
} from "../../src/services/numbers/number-block-client";

export interface FakeSaasManifest {
  latestBundleId: string | null;
  latestBundleHash: string | null;
  latestGlobalSequenceNo: number | null;
  latestGlobalBundleHash: string | null;
  updatedAt: string | null;
}

/** In-memory SaaS control plane: idempotent sequence + manifest maintenance. */
export class FakeSequencerClient implements SequencerClient, NumberDelegationClient {
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

  private readonly blocks = new Map<string, DelegatedBlock>();
  private readonly prefixNext = new Map<string, number>();
  private blockSeq = 0;
  private issuedTotal = 0;
  readonly reconciliations: ReconcileRequest[] = [];

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

  async issueBlock(req: BlockIssueRequest): Promise<DelegatedBlock> {
    const key = `${req.docType}:${req.prefix}`;
    const from = this.prefixNext.get(key) ?? 1;
    const to = from + Math.max(1, req.size) - 1;
    this.prefixNext.set(key, to + 1);
    this.blockSeq += 1;
    const block: DelegatedBlock = {
      blockId: `blk_${this.blockSeq}`,
      docType: req.docType,
      prefix: req.prefix,
      rangeFrom: from,
      rangeTo: to,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      quotaLimit: 1000,
      quotaUsed: this.issuedTotal,
    };
    this.blocks.set(block.blockId, block);
    return block;
  }

  async blockStatus(blockId: string): Promise<DelegatedBlock | null> {
    return this.blocks.get(blockId) ?? null;
  }

  async reconcile(req: ReconcileRequest): Promise<void> {
    this.reconciliations.push({ ...req });
    this.issuedTotal += req.consumed.length + req.voided.length;
  }

  blocksIssued(): DelegatedBlock[] {
    return [...this.blocks.values()];
  }
}

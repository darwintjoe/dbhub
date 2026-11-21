import { NumberRelayError } from "./errors";

/** A block of official numbers delegated by SaaS to this Hub. */
export interface DelegatedBlock {
  blockId: string;
  docType: string;
  prefix: string;
  rangeFrom: number;
  rangeTo: number;
  expiresAt: string;
  quotaLimit: number;
  quotaUsed: number;
}

export interface BlockIssueRequest {
  docType: string;
  prefix: string;
  size: number;
  deviceId: string;
}

export interface ReconcileRequest {
  blockId: string;
  consumed: number[];
  voided: number[];
}

/** Upstream delegated-number interface, implemented by the SaaS client. */
export interface NumberDelegationClient {
  readonly name: string;
  issueBlock(req: BlockIssueRequest): Promise<DelegatedBlock>;
  blockStatus(blockId: string): Promise<DelegatedBlock | null>;
  reconcile(req: ReconcileRequest): Promise<void>;
}

/**
 * No upstream configured. Already-delegated blocks may drain; when exhausted
 * number issuance stops instead of reusing or inventing numbers.
 */
export class OfflineNumberDelegationClient implements NumberDelegationClient {
  readonly name = "numbers-offline";

  async issueBlock(): Promise<DelegatedBlock> {
    throw new NumberRelayError("NUM-004", "No delegated block available while SaaS is unreachable.", 503);
  }

  async blockStatus(): Promise<DelegatedBlock | null> {
    return null;
  }

  async reconcile(): Promise<void> {
    // Nothing to report upstream while offline.
  }
}

/**
 * Deferred W3 contract (fazai side). Contract only — intentionally not
 * implemented in DBHub. W3 will let a device request a number from its Hub
 * relay with these shapes; the Hub-side endpoints already exist.
 *
 * No fazai source is referenced or modified here.
 */
export const W3_NUMBER_PATH = "/api/v1/numbers/next";

export interface W3NumberRequest {
  doc_type: string;
  prefix: string;
  idempotency_key: string;
}

export interface W3NumberResponse {
  number: number;
  doc_type: string;
  prefix: string;
  block_id: string;
  idempotency_key: string;
}

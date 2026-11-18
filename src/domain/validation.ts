import { z } from "zod";
import { SUPPORTED_BUNDLE_FORMAT_VERSION, SUPPORTED_SCHEMA_VERSION } from "./types";

const ledgerEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  occurredAt: z.string().optional(),
  data: z.unknown(),
});

export const bundleSchema = z
  .object({
    bundleId: z.string().regex(/^bdl_/),
    companyId: z.string().min(1),
    ledgerStreamId: z.string().min(1),
    deviceId: z.string().regex(/^dev_/),
    userId: z.string().min(1),
    period: z.string().regex(/^\d{4}-\d{2}$/),
    devicePrevHash: z.string().nullable(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
    eventCount: z.number().int().nonnegative(),
    schemaVersion: z.number().int(),
    bundleFormatVersion: z.number().int(),
    createdAt: z.string().min(1),
    signature: z.string().optional(),
    payload: z.array(ledgerEventSchema),
  })
  .refine((b) => b.eventCount === b.payload.length, {
    message: "eventCount must equal payload.length",
    path: ["eventCount"],
  })
  .refine((b) => b.schemaVersion <= SUPPORTED_SCHEMA_VERSION, {
    message: "unsupported schemaVersion",
    path: ["schemaVersion"],
  })
  .refine((b) => b.bundleFormatVersion <= SUPPORTED_BUNDLE_FORMAT_VERSION, {
    message: "unsupported bundleFormatVersion",
    path: ["bundleFormatVersion"],
  });

export type ParsedBundle = z.infer<typeof bundleSchema>;

export function validateBundleShape(input: unknown): { ok: true; data: ParsedBundle } | { ok: false; details: unknown } {
  const res = bundleSchema.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  return { ok: false, details: res.error.flatten() };
}

export function duplicateEventIdsInPayload(payload: { id: string }[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const e of payload) {
    if (seen.has(e.id)) dup.push(e.id);
    seen.add(e.id);
  }
  return dup;
}

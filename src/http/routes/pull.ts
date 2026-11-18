import type { Request, Response } from "express";
import { z } from "zod";
import { Router } from "express";
import type { BundlesRepo } from "../../db/bundles.repo";
import { ApiError } from "../errors";

const querySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export function pullRoutes(bundles: BundlesRepo) {
  const router = Router();
  router.get("/", (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new ApiError(400, "BUNDLE-001", "Invalid query.");
    const { since, limit } = parsed.data;
    const rows = bundles.acceptedSince(since, limit);
    const bundlesOut = rows.map((b) => ({
      hubSeq: b.hubSeq,
      bundleId: b.bundleId,
      bundleHash: b.bundleHash,
      chainPrevHash: b.chainPrevHash,
      chainHash: b.chainHash,
      createdAt: b.createdAt,
      payload: b.payload,
    }));
    const lastRow = rows[rows.length - 1];
    const nextSince = lastRow ? lastRow.hubSeq : since;
    res.json({ bundles: bundlesOut, nextSince });
  });
  return router;
}

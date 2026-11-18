import type { Request, Response } from "express";
import { z } from "zod";
import { Router } from "express";
import type { BundlesRepo } from "../../db/bundles.repo";
import { ApiError } from "../errors";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().default("quarantined"),
});

export function quarantineRoutes(bundles: BundlesRepo) {
  const router = Router();
  router.get("/", (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new ApiError(400, "BUNDLE-001", "Invalid query.");
    const list = bundles.quarantineList(parsed.data.status, parsed.data.limit);
    res.json({ items: list });
  });
  router.get("/:bundleId", (req: Request, res: Response) => {
    const b = bundles.quarantineDetail(String(req.params.bundleId));
    if (!b) throw new ApiError(404, "BUNDLE-001", "Bundle not found.");
    res.json(b);
  });
  return router;
}

import type { Request, Response } from "express";
import { Router } from "express";
import type { Config } from "../../config";
import type { ManifestsRepo } from "../../db/manifests.repo";


export function manifestRoutes(config: Config, manifests: ManifestsRepo) {
  const router = Router();
  router.get("/", (_req: Request, res: Response) => {
    const m = manifests.get(config.replicaId);
    if (!m) {
      // return an empty manifest
      res.json({
        manifestId: config.replicaId,
        companyId: config.companyId,
        ledgerStreamId: "main",
        replicaId: config.replicaId,
        replicaType: "hub",
        latestBundleId: null,
        latestBundleHash: null,
        latestHubSeq: 0,
        latestChainHash: null,
        latestAcceptedSeq: 0,
        latestSnapshotId: null,
        latestClosedPeriod: null,
        schemaVersion: 1,
        bundleFormatVersion: 1,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    res.json(m);
  });
  return router;
}

import type { Request, Response } from "express";
import { Router } from "express";
import type { MaintenanceService } from "../../services/maintenance";
import type { BatchingService } from "../../services/batching";
import type { OutboxRepo } from "../../db/outbox.repo";

export function maintenanceRoutes(
  maintenance: MaintenanceService,
  batching: BatchingService,
  outbox: OutboxRepo,
) {
  const router = Router();
  router.post("/verify-chain", (_req: Request, res: Response) => {
    res.json(maintenance.verifyChain());
  });
  router.post("/checkpoint", (_req: Request, res: Response) => {
    maintenance.checkpoint();
    res.json({ ok: true });
  });
  router.get("/outbox", (_req: Request, res: Response) => {
    res.json({ counts: outbox.counts(), lastErrors: outbox.lastErrors() });
  });
  router.post("/run-outbox", async (_req: Request, res: Response) => {
    await batching.processOnce();
    res.json({ ok: true });
  });
  return router;
}

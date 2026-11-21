import type { Request, Response } from "express";
import { Router } from "express";
import type { IngestService } from "../../services/ingest";
import type { DevicesRepo } from "../../db/devices.repo";
import { ApiError } from "../errors";

export function relayRoutes(ingest: IngestService, devices: DevicesRepo) {
  const router = Router();
  router.post("/bundles", (req: Request, res: Response) => {
    const authed = req as Request & { device?: { id: string } };
    if (!authed.device) throw new ApiError(401, "AUTH-001", "Missing device.");
    const device = devices.findById(authed.device.id);
    if (!device) throw new ApiError(401, "AUTH-001", "Invalid device.");
    // Device -> Hub is the sanctioned Profile B relay. hub_origin is enforced
    // at /sync/sequence (sequencer-client), never at this device-facing edge.
    const result = ingest.ingest(req.body, device);
    res.json(result);
  });
  return router;
}

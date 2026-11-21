import type { Request, Response } from "express";
import { Router } from "express";
import type { IngestService } from "../../services/ingest";
import type { DevicesRepo } from "../../db/devices.repo";
import type { Config } from "../../config";
import { ApiError } from "../errors";

export function relayRoutes(ingest: IngestService, devices: DevicesRepo, config?: Config) {
  const router = Router();
  router.post("/bundles", (req: Request, res: Response) => {
    const authed = req as Request & { device?: { id: string } };
    if (!authed.device) throw new ApiError(401, "AUTH-001", "Missing device.");
    const device = devices.findById(authed.device.id);
    if (!device) throw new ApiError(401, "AUTH-001", "Invalid device.");
    if (config?.saas?.profile === "hub_required") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hubOrigin = body.hub_origin === true || body.hubOrigin === true;
      if (!hubOrigin) {
        throw new ApiError(403, "SAAS-003", "Profile B rejects uploads not relayed through Hub.");
      }
    }
    const result = ingest.ingest(req.body, device);
    res.json(result);
  });
  return router;
}

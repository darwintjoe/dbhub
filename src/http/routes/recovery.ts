import type { Request, Response } from "express";
import { Router } from "express";
import { errorEnvelope } from "../errors";
import { RecoveryError, type RecoveryService } from "../../services/replica/recovery";

function fail(res: Response, err: unknown): void {
  if (err instanceof RecoveryError) {
    const status = err.code === "RECOVER-002" ? 404 : 409;
    res.status(status).json(errorEnvelope(err.code, err.message, {}));
    return;
  }
  res.status(500).json(errorEnvelope("SYS-500", "Internal server error.", {}));
}

function param(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function recoveryRoutes(recovery: RecoveryService) {
  const router = Router();

  router.post("/snapshot", async (_req, res) => {
    try {
      res.status(201).json(await recovery.writeSnapshot());
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/snapshot", async (_req, res) => {
    try {
      const snapshot = await recovery.readSnapshot();
      if (!snapshot) {
        res.status(404).json(errorEnvelope("RECOVER-002", "No recovery point has been saved yet.", {}));
        return;
      }
      res.json(snapshot);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/closing-pack/:period", async (req: Request, res: Response) => {
    try {
      res.status(201).json(await recovery.writeClosingPack(param(req.params.period)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/closing-pack/:period", async (req: Request, res: Response) => {
    try {
      const pack = await recovery.readClosingPack(param(req.params.period));
      if (!pack) {
        res.status(404).json(errorEnvelope("RECOVER-004", "Closing pack not found.", {}));
        return;
      }
      res.json(pack);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/rebuild", async (_req, res) => {
    try {
      res.json(await recovery.rebuild());
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

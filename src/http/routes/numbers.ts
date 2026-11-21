import type { Request, Response } from "express";
import { Router } from "express";
import type { AuthedRequest } from "../auth";
import { errorEnvelope } from "../errors";
import { NumberRelayError } from "../../services/numbers/errors";
import type { NumberRelayService } from "../../services/numbers/number-relay";

function fail(res: Response, err: unknown): void {
  if (err instanceof NumberRelayError) {
    res.status(err.status).json(errorEnvelope(err.code, err.message, {}));
    return;
  }
  res.status(500).json(errorEnvelope("SYS-500", "Internal server error.", {}));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function intArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === "number").map((n) => Math.trunc(n)) : [];
}

/** Device-facing LAN number relay. No fazai changes required (W3 contract only). */
export function numberRoutes(relay: NumberRelayService) {
  const router = Router();
  const deviceId = (req: Request): string => (req as AuthedRequest).device?.id ?? str(req.query.device_id);

  const next = async (req: Request, res: Response): Promise<void> => {
    try {
      const source = req.method === "GET" ? req.query : (req.body ?? {});
      const result = await relay.next({
        docType: str(source.doc_type),
        prefix: str(source.prefix),
        idempotencyKey: str(source.idempotency_key),
        deviceId: deviceId(req) || str(source.device_id),
      });
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  };

  router.get("/next", next);
  router.post("/next", next);

  router.post("/block", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const size = typeof body.size === "number" ? Math.trunc(body.size) : undefined;
      const block = await relay.issueBlock({
        docType: str(body.doc_type),
        prefix: str(body.prefix),
        size,
        deviceId: deviceId(req),
      });
      res.status(201).json(block);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/block", (_req, res) => {
    try {
      res.json({ blocks: relay.listStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/block/:id", (req, res) => {
    try {
      res.json(relay.status(str(req.params.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/reconcile", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await relay.reconcile({
        blockId: str(body.block_id || body.blockId),
        consumed: intArray(body.consumed),
        voided: intArray(body.voided),
      });
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/void", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await relay.voidNumber(str(body.idempotency_key)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/abandon", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await relay.abandonBlock(str(body.block_id || body.blockId)));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

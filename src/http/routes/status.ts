import type { Request, Response } from "express";
import type { Config } from "../../config";
import type { BundlesRepo } from "../../db/bundles.repo";
import type { DevicesRepo } from "../../db/devices.repo";
import type { ReplicaHealth } from "../../services/replica/replica-health";
import { VERSION } from "../../domain/types";

export function statusHandler(
  config: Config,
  bundles: BundlesRepo,
  _devices: DevicesRepo,
  healthProvider?: () => ReplicaHealth | Promise<ReplicaHealth>,
) {
  return async (_req: Request, res: Response) => {
    const latest = bundles.acceptedHead();
    const insertionHead = bundles.lastAcceptedHead();
    const health = healthProvider ? await healthProvider() : null;
    res.json({
      version: VERSION,
      companyId: config.companyId,
      uptimeSec: Math.floor(process.uptime()),
      counts: {
        devices: bundles.countDevices(),
        accepted: bundles.countByStatus("accepted"),
        pendingParent: bundles.countByStatus("pending_parent"),
        quarantined: bundles.countByStatus("quarantined"),
        events: bundles.countEvents(),
      },
      chain: {
        latestAcceptedSeq: latest ? (latest.acceptedSeq ?? 0) : 0,
        latestHubSeq: insertionHead ? insertionHead.hubSeq : 0,
        latestChainHash: latest ? latest.chainHash : null,
      },
      lastBundleAt: bundles.lastReceivedAt(),
      ...(health
        ? {
            dataSafety: {
              level: health.level,
              score: health.score,
              label: health.label,
              message: health.message,
              action: health.action,
            },
          }
        : {}),
    });
  };
}

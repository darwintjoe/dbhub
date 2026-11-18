import type { Request, Response } from "express";
import type { Config } from "../../config";
import type { BundlesRepo } from "../../db/bundles.repo";
import type { DevicesRepo } from "../../db/devices.repo";

export function statusHandler(config: Config, bundles: BundlesRepo, devices: DevicesRepo) {
  return (_req: Request, res: Response) => {
    const latest = bundles.acceptedHead();
    const insertionHead = bundles.lastAcceptedHead();
    res.json({
      version: "0.2.0",
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
    });
  };
}

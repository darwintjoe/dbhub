import fs from "node:fs";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../../config";
import type { ConfigService } from "../../services/config-service";
import type { CloudflareTunnelProvider } from "../../services/cloudflare-tunnel";
import { ApiError } from "../errors";
import { asyncHandler } from "../async-handler";

export interface ConnectivityDeps {
  config: Config;
  configService: ConfigService;
  tunnel: CloudflareTunnelProvider;
  audit?: any;
}

export function connectivityRoutes(deps: ConnectivityDeps) {
  const router = Router();
  const { config, configService, tunnel, audit } = deps;

  router.get("/", (_req: Request, res: Response) => {
    const cfg = configService.getConfig();
    res.json({
      mode: cfg.connectivity.mode,
      publicUrl: cfg.connectivity.publicUrl,
      publicDomain: cfg.connectivity.publicDomain,
      publicPort: cfg.connectivity.publicPort,
      cloudflare: {
        binaryPath: cfg.connectivity.cloudflare.binaryPath,
        tunnelTokenFile: cfg.connectivity.cloudflare.tunnelTokenFile,
        autoStart: cfg.connectivity.cloudflare.autoStart,
        tokenConfigured: Boolean(cfg.connectivity.cloudflare.tunnelTokenFile),
      },
      mdns: cfg.connectivity.mdns,
      tunnel: tunnel.getStatus(),
      ingressInstruction: `Public hostname -> http://127.0.0.1:${cfg.connectivity.publicPort}`,
    });
  });

  router.put("/", asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      mode: z.enum(["lan", "cloudflare"]).optional(),
      publicUrl: z.string().optional(),
      publicDomain: z.string().optional(),
      publicPort: z.number().int().min(1).max(65535).optional(),
      cloudflare: z.object({
        binaryPath: z.string().optional(),
        tunnelTokenFile: z.string().optional(),
        autoStart: z.boolean().optional(),
      }).optional(),
      mdns: z.object({ enabled: z.boolean().optional() }).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, "CONFIG-001", "Invalid connectivity payload.", { details: parsed.error.flatten() });

    const current = configService.getConfig() as any;
    const merged = JSON.parse(JSON.stringify(current));
    if (parsed.data.mode !== undefined) merged.connectivity.mode = parsed.data.mode;
    if (parsed.data.publicUrl !== undefined) merged.connectivity.publicUrl = parsed.data.publicUrl;
    if (parsed.data.publicDomain !== undefined) merged.connectivity.publicDomain = parsed.data.publicDomain;
    if (parsed.data.publicPort !== undefined) merged.connectivity.publicPort = parsed.data.publicPort;
    if (parsed.data.cloudflare) Object.assign(merged.connectivity.cloudflare, parsed.data.cloudflare);
    if (parsed.data.mdns) Object.assign(merged.connectivity.mdns, parsed.data.mdns);

    const result = await configService.save({ config: merged, force: true });
    // update tunnel public url
    tunnel.setPublicUrl(merged.connectivity.publicUrl);
    audit?.log(new Date().toISOString(), "admin", "connectivity.saved", { mode: merged.connectivity.mode });
    res.json({ ok: true, hash: result.hash, restartRequired: result.restartRequired });
  }));

  router.post("/restart", asyncHandler(async (_req: Request, res: Response) => {
    const state = await tunnel.restart();
    audit?.log(new Date().toISOString(), "admin", "connectivity.tunnel-restarted", {});
    res.json(state);
  }));

  router.post("/rotate-token", asyncHandler(async (_req: Request, res: Response) => {
    const cfg = configService.getConfig() as any;
    const tokenFile = cfg.connectivity.cloudflare.tunnelTokenFile;
    if (!tokenFile) throw new ApiError(400, "CONFIG-001", "Tunnel token file is not configured.");
    const newToken = "t_" + crypto.randomBytes(24).toString("base64url");
    const tmp = tokenFile + ".tmp";
    fs.writeFileSync(tmp, newToken + "\n", { mode: 0o600 });
    fs.renameSync(tmp, tokenFile);
    await tunnel.stop();
    await tunnel.start();
    audit?.log(new Date().toISOString(), "admin", "connectivity.token-rotated", {});
    res.json({ ok: true, message: "Token rotated. Tunnel restarted." });
  }));

  router.post("/test", asyncHandler(async (_req: Request, res: Response) => {
    const cfg = configService.getConfig() as any;
    const port = cfg.connectivity.publicPort;
    let localOk = false;
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/healthz");
      localOk = r.ok;
    } catch {
      localOk = false;
    }
    const state = tunnel.getStatus();
    res.json({
      tunnel: state,
      localPublicListener: "http://127.0.0.1:" + port + "/healthz",
      localOk,
      tunnelProcessRunning: state.pid !== null,
      binaryFound: state.status !== "not_installed",
      lastError: state.lastError,
      externalCheck: "Open the public URL /healthz from a phone to verify WAN reachability.",
      ok: localOk && (state.status === "connected" || state.status === "disabled"),
    });
  }));

  return router;
}
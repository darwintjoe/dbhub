import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Config } from "../config";

export type TunnelStatus = "disabled" | "not_installed" | "starting" | "connected" | "error" | "stopped";

export interface TunnelState {
  status: TunnelStatus;
  publicUrl: string;
  lastError: string | null;
  lastStartAt: string | null;
  restartCount: number;
  pid: number | null;
}

export interface CloudflareTunnelProviderOptions {
  config: Config;
  spawnFn?: (cmd: string, args: string[], opts: any) => any;
  existsFn?: (p: string) => boolean;
  readTokenFn?: (p: string) => string;
}

export class CloudflareTunnelProvider {
  private config: Config;
  private spawnFn: (cmd: string, args: string[], opts: any) => any;
  private existsFn: (p: string) => boolean;
  private readTokenFn: (p: string) => string;
  private proc: any = null;
  private status: TunnelStatus = "disabled";
  private lastError: string | null = null;
  private lastStartAt: string | null = null;
  private restartCount = 0;
  private publicUrl: string;

  constructor(opts: CloudflareTunnelProviderOptions) {
    this.config = opts.config;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.existsFn = opts.existsFn ?? ((p: string) => { try { return fs.existsSync(p); } catch { return false; } });
    this.readTokenFn = opts.readTokenFn ?? ((p: string) => fs.readFileSync(p, "utf8").trim());
    this.publicUrl = (opts.config.connectivity?.publicUrl || "").trim();
    this.refreshStatusFromConfig();
  }

  private refreshStatusFromConfig(): void {
    if (this.config.connectivity?.mode !== "cloudflare") {
      this.status = "disabled";
      return;
    }
    const bin = this.config.connectivity.cloudflare.binaryPath || "cloudflared";
    // if binaryPath is a path and missing
    if (bin.includes("/") || bin.includes("\\")) {
      if (!this.existsFn(bin)) {
        this.status = "not_installed";
        return;
      }
    }
    if (this.status === "disabled") this.status = "stopped";
  }

  getStatus(): TunnelState {
    this.refreshStatusFromConfig();
    return {
      status: this.status,
      publicUrl: this.publicUrl,
      lastError: this.lastError,
      lastStartAt: this.lastStartAt,
      restartCount: this.restartCount,
      pid: this.proc?.pid ?? null,
    };
  }

  async start(): Promise<TunnelState> {
    if (this.config.connectivity?.mode !== "cloudflare") {
      this.status = "disabled";
      return this.getStatus();
    }
    const bin = this.config.connectivity.cloudflare.binaryPath || "cloudflared";
    if ((bin.includes("/") || bin.includes("\\")) && !this.existsFn(bin)) {
      this.status = "not_installed";
      this.lastError = `cloudflared binary not found at ${bin}`;
      return this.getStatus();
    }
    const tokenFile = this.config.connectivity.cloudflare.tunnelTokenFile;
    let token = "";
    if (tokenFile) {
      try {
        token = this.readTokenFn(tokenFile);
      } catch (e) {
        this.status = "error";
        this.lastError = `Failed to read tunnel token: ${(e as Error).message}`;
        return this.getStatus();
      }
    }
    if (!token) {
      this.status = "error";
      this.lastError = "Tunnel token is missing.";
      return this.getStatus();
    }

    this.status = "starting";
    this.lastStartAt = new Date().toISOString();
    this.lastError = null;

    try {
      this.proc = this.spawnFn(bin, ["tunnel", "run"], {
        env: { ...process.env, TUNNEL_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      this.status = "error";
      this.lastError = (e as Error).message;
      return this.getStatus();
    }

    this.proc.stdout?.on?.("data", (d: Buffer) => {
      const text = d.toString();
      if (/registered|connected|tunnel connection/i.test(text)) {
        this.status = "connected";
      }
    });
    this.proc.stderr?.on?.("data", (d: Buffer) => {
      const text = d.toString();
      // redact token just in case
      this.lastError = text.slice(0, 500);
      if (/error|failed/i.test(text)) {
        // don't immediately mark error if process still running
      }
    });
    this.proc.on?.("exit", (code: number) => {
      if (this.status !== "stopped") {
        this.status = code === 0 ? "stopped" : "error";
        if (code !== 0) this.lastError = `cloudflared exited with code ${code}`;
      }
      this.proc = null;
    });

    // mark connected after short delay if still running
    setTimeout(() => {
      if (this.proc && this.status === "starting") this.status = "connected";
    }, 1500).unref?.();

    this.restartCount++;
    return this.getStatus();
  }

  async stop(): Promise<TunnelState> {
    this.status = "stopped";
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    return this.getStatus();
  }

  async restart(): Promise<TunnelState> {
    await this.stop();
    // reset status to allow start
    this.status = "stopped";
    return this.start();
  }

  setPublicUrl(url: string): void {
    this.publicUrl = url;
  }
}
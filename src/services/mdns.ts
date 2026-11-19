import os from "node:os";
import type { Config } from "../config";
import { sanitizeSerial } from "./endpoints";

export function mdnsHostname(serial: string, existing: Set<string> = new Set()): string {
  const base = sanitizeSerial(serial);
  let candidate = `dbhub-${base}.local`;
  if (!existing.has(candidate)) return candidate;
  let n = 2;
  while (existing.has(`dbhub-${base}-${n}.local`)) n++;
  return `dbhub-${base}-${n}.local`;
}

export interface MdnsServiceOptions {
  serial: string;
  port: number;
  enabled: boolean;
  company?: string;
  setupRequired?: () => boolean;
}

export class MdnsService {
  private readonly serial: string;
  private readonly port: number;
  private readonly enabled: boolean;
  private readonly company: string;
  private readonly setupRequired: () => boolean;
  private bonjour: any = null;
  private service: any = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: MdnsServiceOptions) {
    this.serial = opts.serial;
    this.port = opts.port;
    this.enabled = opts.enabled;
    this.company = opts.company ?? "";
    this.setupRequired = opts.setupRequired ?? (() => false);
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    try {
      const mod: any = await import("bonjour-service");
      const Bonjour = mod.default ?? mod.Bonjour ?? mod;
      this.bonjour = new Bonjour();
      this.publish();
      this.timer = setInterval(() => this.publish(), 60_000);
      this.timer.unref?.();
    } catch {
      // ignore missing dependency
    }
  }

  private privateIps(): string[] {
    const out: string[] = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] ?? []) {
        if (info.family !== "IPv4" || info.internal) continue;
        const m = info.address.match(/^(\d+)\./);
        if (!m) continue;
        const a = Number(m[1]);
        if (a === 127) continue;
        // only private
        if (!(a === 10 || a === 172 || a === 192)) continue;
        out.push(info.address);
      }
    }
    return [...new Set(out)];
  }

  private publish(): void {
    if (!this.bonjour) return;
    try {
      if (this.service) {
        try { this.service.stop?.(); } catch { /* ignore */ }
      }
      const hostname = mdnsHostname(this.serial, new Set());
      const txt = {
        v: "1",
        serial: this.serial,
        company: this.company,
        setup: this.setupRequired() ? "1" : "0",
        path: "/admin",
      };
      this.service = this.bonjour.publish({
        name: hostname,
        type: "dbhub",
        protocol: "tcp",
        port: this.port,
        host: hostname,
        txt,
      });
    } catch {
      // ignore
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.service?.stop?.(); } catch { /* ignore */ }
    try { this.bonjour?.destroy?.(); } catch { /* ignore */ }
    this.service = null;
    this.bonjour = null;
  }
}
import os from "node:os";
import type { Config } from "../config";
import { sanitizeSerial } from "../config";

export interface EndpointEntry {
  type: "lan" | "mdns" | "wan";
  url: string;
  priority: number;
  label?: string;
}

export interface ResolvedEndpoints {
  lan: EndpointEntry[];
  mdns: EndpointEntry | null;
  wan: EndpointEntry | null;
  all: EndpointEntry[];
  preferred: string;
}

function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function listLanIps(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== "IPv4") continue;
      if (info.internal) continue;
      if (!isPrivateIpv4(info.address)) continue;
      out.push(info.address);
    }
  }
  return [...new Set(out)];
}

export function resolveEndpoints(config: Config, serial: string, mdnsHost?: string): ResolvedEndpoints {
  const port = config.port;
  const lanIps = listLanIps();
  const lan: EndpointEntry[] = lanIps.map((ip) => ({
    type: "lan",
    url: `http://${ip}:${port}`,
    priority: 10,
    label: ip,
  }));

  const host = mdnsHost ?? `dbhub-${sanitizeSerial(serial)}.local`;
  const mdns: EndpointEntry | null = {
    type: "mdns",
    url: `http://${host}:${port}`,
    priority: 20,
    label: host,
  };

  let wan: EndpointEntry | null = null;
  const publicUrl = (config.connectivity?.publicUrl || config.publicUrl || "").trim();
  if (publicUrl) {
    wan = { type: "wan", url: publicUrl.replace(/\/$/, ""), priority: 100, label: "wan" };
  }

  const all = [...lan, mdns, ...(wan ? [wan] : [])].sort((a, b) => a.priority - b.priority);
  const preferred = all[0]?.url ?? `http://localhost:${port}`;

  return { lan, mdns, wan, all, preferred };
}

export { sanitizeSerial } from "../config";

import os from "node:os";
import fs from "node:fs";

export interface DiskSample {
  mount: string;
  label?: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  readBytesPerSec?: number | null;
  writeBytesPerSec?: number | null;
  busyPercent?: number | null;
  queueLength?: number | null;
}

export interface NicSample {
  name: string;
  description?: string;
  status?: string;
  linkSpeedMbps?: number | null;
  mac?: string;
  ipv4?: string[];
  ipv6?: string[];
  rxBytesPerSec?: number | null;
  txBytesPerSec?: number | null;
  rxErrors?: number | null;
  txErrors?: number | null;
  rxDiscards?: number | null;
  txDiscards?: number | null;
  cumulativeRxBytes?: number | null;
  cumulativeTxBytes?: number | null;
}

export interface HostSample {
  available: boolean;
  reason?: string;
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  cpuLogical: number;
  cpuSpeedMhz: number;
  loadAvg: number[];
  cpuPercentTotal: number | null;
  cpuPercentPerCore: number[] | null;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  memoryUsedBytes: number;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  uptimeSec: number;
  disks: DiskSample[];
  network: NicSample[];
  sampledAt: string;
}

export interface HardwareInventory {
  available: boolean;
  reason?: string;
  cpu: { model: string; cores: number; logical: number; speedMhz: number };
  memoryModules: { capacityBytes: number; speedMhz?: number; manufacturer?: string }[];
  physicalDisks: { model: string; sizeBytes: number; interface?: string }[];
  logicalVolumes: { mount: string; label?: string; totalBytes: number }[];
  nics: { name: string; description?: string; mac?: string; speedMbps?: number }[];
  baseboard?: { manufacturer?: string; model?: string };
  bios?: { manufacturer?: string; version?: string };
  os: { caption: string; version: string };
  cachedAt: string;
}

export async function collectGenericHost(): Promise<HostSample> {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  let disks: DiskSample[] = [];
  try {
    const st = fs.statfsSync(process.cwd());
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    disks = [
      {
        mount: process.cwd(),
        totalBytes: total,
        freeBytes: free,
        usedBytes: total - free,
        usedPercent: total ? ((total - free) / total) * 100 : 0,
      },
    ];
  } catch {
    disks = [];
  }
  const nics = Object.entries(os.networkInterfaces()).map(([name, infos]) => ({
    name,
    ipv4: (infos ?? []).filter((i) => i.family === "IPv4").map((i) => i.address),
    ipv6: (infos ?? []).filter((i) => i.family === "IPv6").map((i) => i.address),
    mac: (infos ?? [])[0]?.mac ?? "",
    status: "unknown",
    rxBytesPerSec: null,
    txBytesPerSec: null,
    cumulativeRxBytes: null,
    cumulativeTxBytes: null,
  })) as any;
  return {
    available: true,
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    cpuLogical: cpus.length,
    cpuSpeedMhz: cpus[0]?.speed ?? 0,
    loadAvg: os.loadavg(),
    cpuPercentTotal: null,
    cpuPercentPerCore: null,
    memoryTotalBytes: totalMem,
    memoryFreeBytes: freeMem,
    memoryUsedBytes: totalMem - freeMem,
    swapTotalBytes: null,
    swapFreeBytes: null,
    uptimeSec: os.uptime(),
    disks,
    network: nics,
    sampledAt: new Date().toISOString(),
  };
}

export async function collectGenericHardware(): Promise<HardwareInventory> {
  const cpus = os.cpus();
  return {
    available: true,
    cpu: { model: cpus[0]?.model ?? "unknown", cores: 1, logical: cpus.length, speedMhz: cpus[0]?.speed ?? 0 },
    memoryModules: [{ capacityBytes: os.totalmem() }],
    physicalDisks: [],
    logicalVolumes: [],
    nics: Object.keys(os.networkInterfaces()).map((name) => ({ name })),
    baseboard: undefined,
    bios: undefined,
    os: { caption: `${os.platform()} ${os.release()}`, version: os.release() },
    cachedAt: new Date().toISOString(),
  } as any;
}

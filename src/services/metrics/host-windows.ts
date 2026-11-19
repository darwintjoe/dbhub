import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type {
  HardwareInventory,
  HostSample,
  NicSample,
  DiskSample,
} from "./host-generic";

const execFileAsync = promisify(execFile);

export interface HostAdapter {
  available: boolean;
  reason?: string;
  sample(): Promise<HostSample>;
  hardware(): Promise<HardwareInventory>;
}

const DYNAMIC_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1",
  "$cs=Get-CimInstance Win32_ComputerSystem",
  "$cpuTotal=(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples[0].CookedValue",
  "$cpuCores=(Get-Counter '\\Processor(*)\\% Processor Time').CounterSamples | Where-Object { $_.InstanceName -ne '_Total' } | ForEach-Object { [math]::Round($_.CookedValue,2) }",
  "$disks=Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | ForEach-Object { [pscustomobject]@{ mount=$_.DeviceID; label=$_.VolumeName; totalBytes=[int64]$_.Size; freeBytes=[int64]$_.FreeSpace } }",
  "$adapters=Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -or $_.Status -eq 'Disconnected' }",
  "$net=@()",
  "foreach ($a in $adapters) { $s=Get-NetAdapterStatistics -Name $a.Name -ErrorAction SilentlyContinue; $net += [pscustomobject]@{ name=$a.Name; description=$a.InterfaceDescription; status=$a.Status.ToString(); linkSpeedMbps=$a.LinkSpeed; mac=$a.MacAddress; ipv4=@(); ipv6=@(); cumulativeRxBytes=if($s){$s.ReceivedBytes}else{0}; cumulativeTxBytes=if($s){$s.SentBytes}else{0}; rxErrors=if($s){$s.ReceivedErrors}else{0}; txErrors=if($s){$s.OutboundErrors}else{0}; rxDiscards=if($s){$s.ReceivedDiscardedPackets}else{0}; txDiscards=if($s){$s.OutboundDiscardedPackets}else{0} } }",
  "$ipconfig=Get-NetIPAddress -ErrorAction SilentlyContinue",
  "foreach ($n in $net) { $n.ipv4=@($ipconfig | Where-Object { $_.InterfaceAlias -eq $n.name -and $_.AddressFamily -eq 'IPv4' } | ForEach-Object { $_.IPAddress }); $n.ipv6=@($ipconfig | Where-Object { $_.InterfaceAlias -eq $n.name -and $_.AddressFamily -eq 'IPv6' } | ForEach-Object { $_.IPAddress }) }",
  "[pscustomobject]@{ hostname=$env:COMPUTERNAME; platform='win32'; release=$os.Version; arch=$env:PROCESSOR_ARCHITECTURE; cpuModel=$cpu.Name; cpuCores=$cpu.NumberOfCores; cpuLogical=$cs.NumberOfLogicalProcessors; cpuSpeedMhz=$cpu.MaxClockSpeed; loadAvg=@(); cpuPercentTotal=[math]::Round($cpuTotal,2); cpuPercentPerCore=@($cpuCores); memoryTotalBytes=[int64]($os.TotalVisibleMemorySize*1KB); memoryFreeBytes=[int64]($os.FreePhysicalMemory*1KB); swapTotalBytes=$null; swapFreeBytes=$null; uptimeSec=[int64]((Get-Date)-$os.LastBootUpTime).TotalSeconds; disks=@($disks); network=@($net) } | ConvertTo-Json -Depth 6 -Compress",
].join("; ");

const HARDWARE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1",
  "$cs=Get-CimInstance Win32_ComputerSystem",
  "$mem=Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [pscustomobject]@{ capacityBytes=[int64]$_.Capacity; speedMhz=$_.Speed; manufacturer=$_.Manufacturer } }",
  "$phys=Get-CimInstance Win32_DiskDrive | ForEach-Object { [pscustomobject]@{ model=$_.Model; sizeBytes=[int64]$_.Size; interface=$_.InterfaceType } }",
  "$vols=Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | ForEach-Object { [pscustomobject]@{ mount=$_.DeviceID; label=$_.VolumeName; totalBytes=[int64]$_.Size } }",
  "$nics=Get-CimInstance Win32_NetworkAdapter | Where-Object { $_.MACAddress } | ForEach-Object { [pscustomobject]@{ name=$_.Name; description=$_.Description; mac=$_.MACAddress; speedMbps=[math]::Round($_.Speed/1MB,2) } }",
  "$bb=Get-CimInstance Win32_BaseBoard | Select-Object -First 1",
  "$bios=Get-CimInstance Win32_BIOS | Select-Object -First 1",
  "[pscustomobject]@{ cpu=@{ model=$cpu.Name; cores=$cpu.NumberOfCores; logical=$cs.NumberOfLogicalProcessors; speedMhz=$cpu.MaxClockSpeed }; memoryModules=$mem; physicalDisks=$phys; logicalVolumes=$vols; nics=$nics; baseboard=@{ manufacturer=$bb.Manufacturer; model=$bb.Product }; bios=@{ manufacturer=$bios.Manufacturer; version=$bios.SMBIOSBIOSVersion }; os=@{ caption=$os.Caption; version=$os.Version } } | ConvertTo-Json -Depth 6 -Compress",
].join("; ");

function parseJson(raw: string): any {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // PowerShell may emit multiple lines; try last line.
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]!); } catch { /* continue */ }
    }
    return null;
  }
}

export function parseWindowsDynamic(input: unknown): any {
  const obj = typeof input === "string" ? parseJson(input) : input;
  if (!obj || typeof obj !== "object") return null;
  return obj;
}

export function parseWindowsHardware(input: unknown): any {
  const obj = typeof input === "string" ? parseJson(input) : input;
  if (!obj || typeof obj !== "object") return null;
  return obj;
}

// Aliases
export const parseWindowsCounters = parseWindowsDynamic;
export const mapWindowsHostSample = toHostSample;
export const parseWindowsHostSample = toHostSample;
export const windowsHostSampleFromJson = toHostSample;
export const parseWindowsHost = parseWindowsDynamic;
export const parseWindowsSnapshot = parseWindowsDynamic;
export const parseHostWindows = parseWindowsDynamic;

function parseLinkSpeedMbps(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value).trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(gbps|gigabit|mbps|megabit|kbps|kilobit|bps|bit)?/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = m[2] ?? "mbps";
  if (unit.startsWith("g")) return num * 1000;
  if (unit.startsWith("m")) return num;
  if (unit.startsWith("k")) return num / 1000;
  if (unit.startsWith("b")) return num / 1000000;
  return num;
}

export function toHostSample(
  parsed: any,
  prev?: Map<string, { rx: number; tx: number; t: number }>,
  now: number = Date.now(),
): HostSample {
  const prevMap = prev ?? new Map();
  const diskInput = Array.isArray(parsed?.disks)
    ? parsed.disks
    : parsed?.disks
      ? [parsed.disks]
      : [];
  const disks = diskInput.map((d: any) => ({
        mount: String(d?.mount ?? d?.DeviceID ?? ""),
        label: d?.label ?? d?.VolumeName ?? undefined,
        totalBytes: Number(d?.totalBytes ?? d?.Size ?? 0),
        freeBytes: Number(d?.freeBytes ?? d?.FreeSpace ?? 0),
        usedBytes: 0,
        usedPercent: 0,
        readBytesPerSec: d?.readBytesPerSec ?? null,
        writeBytesPerSec: d?.writeBytesPerSec ?? null,
        busyPercent: d?.busyPercent ?? null,
        queueLength: d?.queueLength ?? null,
      }));
  for (const d of disks) {
    d.usedBytes = Math.max(0, d.totalBytes - d.freeBytes);
    d.usedPercent = d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0;
  }

  const networkInput = Array.isArray(parsed?.network)
    ? parsed.network
    : parsed?.network
      ? [parsed.network]
      : [];
  const network = networkInput.map((n: any): NicSample => {
        const name = String(n?.name ?? n?.Name ?? "");
        const cumRx = Number(n?.cumulativeRxBytes ?? 0);
        const cumTx = Number(n?.cumulativeTxBytes ?? 0);
        let rxRate: number | null = n?.rxBytesPerSec ?? null;
        let txRate: number | null = n?.txBytesPerSec ?? null;
        const old = prevMap.get(name);
        if (rxRate == null && old && cumRx >= old.rx) {
          const dt = (now - old.t) / 1000;
          if (dt > 0) rxRate = (cumRx - old.rx) / dt;
        }
        if (txRate == null && old && cumTx >= old.tx) {
          const dt = (now - old.t) / 1000;
          if (dt > 0) txRate = (cumTx - old.tx) / dt;
        }
        if (old && cumRx < old.rx) rxRate = 0;
        if (old && cumTx < old.tx) txRate = 0;
        prevMap.set(name, { rx: cumRx, tx: cumTx, t: now });
        return {
          name,
          description: n?.description ?? undefined,
          status: n?.status ?? undefined,
          linkSpeedMbps: parseLinkSpeedMbps(n?.linkSpeedMbps),
          mac: n?.mac ?? undefined,
          ipv4: Array.isArray(n?.ipv4) ? n.ipv4 : [],
          ipv6: Array.isArray(n?.ipv6) ? n.ipv6 : [],
          rxBytesPerSec: rxRate,
          txBytesPerSec: txRate,
          rxErrors: n?.rxErrors ?? null,
          txErrors: n?.txErrors ?? null,
          rxDiscards: n?.rxDiscards ?? null,
          txDiscards: n?.txDiscards ?? null,
          cumulativeRxBytes: cumRx,
          cumulativeTxBytes: cumTx,
        };
      });

  return {
    available: true,
    hostname: String(parsed?.hostname ?? os.hostname()),
    platform: "win32",
    release: String(parsed?.release ?? os.release()),
    arch: String(parsed?.arch ?? os.arch()),
    cpuModel: String(parsed?.cpuModel ?? "unknown"),
    cpuCores: Number(parsed?.cpuCores ?? 0),
    cpuLogical: Number(parsed?.cpuLogical ?? 0),
    cpuSpeedMhz: Number(parsed?.cpuSpeedMhz ?? 0),
    loadAvg: Array.isArray(parsed?.loadAvg) ? parsed.loadAvg.map(Number) : [],
    cpuPercentTotal: parsed?.cpuPercentTotal != null ? Number(parsed.cpuPercentTotal) : null,
    cpuPercentPerCore: Array.isArray(parsed?.cpuPercentPerCore) ? parsed.cpuPercentPerCore.map(Number) : null,
    memoryTotalBytes: Number(parsed?.memoryTotalBytes ?? 0),
    memoryFreeBytes: Number(parsed?.memoryFreeBytes ?? 0),
    memoryUsedBytes: Number(parsed?.memoryTotalBytes ?? 0) - Number(parsed?.memoryFreeBytes ?? 0),
    swapTotalBytes: parsed?.swapTotalBytes != null ? Number(parsed.swapTotalBytes) : null,
    swapFreeBytes: parsed?.swapFreeBytes != null ? Number(parsed.swapFreeBytes) : null,
    uptimeSec: Number(parsed?.uptimeSec ?? os.uptime()),
    disks,
    network,
    sampledAt: new Date().toISOString(),
  };
}

function toHardwareInventory(parsed: any): HardwareInventory {
  const toArray = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []);
  const memMods = toArray(parsed?.memoryModules).map((m: any) => ({ capacityBytes: Number(m?.capacityBytes ?? 0), speedMhz: m?.speedMhz, manufacturer: m?.manufacturer }));
  const phys = toArray(parsed?.physicalDisks).map((d: any) => ({ model: String(d?.model ?? ""), sizeBytes: Number(d?.sizeBytes ?? 0), interface: d?.interface }));
  const vols = toArray(parsed?.logicalVolumes).map((v: any) => ({ mount: String(v?.mount ?? ""), label: v?.label, totalBytes: Number(v?.totalBytes ?? 0) }));
  const nics = toArray(parsed?.nics).map((n: any) => ({ name: String(n?.name ?? ""), description: n?.description, mac: n?.mac, speedMbps: n?.speedMbps }));
  return {
    available: true,
    cpu: {
      model: String(parsed?.cpu?.model ?? "unknown"),
      cores: Number(parsed?.cpu?.cores ?? 0),
      logical: Number(parsed?.cpu?.logical ?? 0),
      speedMhz: Number(parsed?.cpu?.speedMhz ?? 0),
    },
    memoryModules: memMods,
    physicalDisks: phys,
    logicalVolumes: vols,
    nics,
    baseboard: parsed?.baseboard ? { manufacturer: parsed.baseboard.manufacturer, model: parsed.baseboard.model } : undefined,
    bios: parsed?.bios ? { manufacturer: parsed.bios.manufacturer, version: parsed.bios.version } : undefined,
    os: { caption: String(parsed?.os?.caption ?? ""), version: String(parsed?.os?.version ?? "") },
    cachedAt: new Date().toISOString(),
  } as any;
}

export class WindowsHostAdapter implements HostAdapter {
  available = true;
  reason?: string;
  private readonly config: any;
  private lastSample: HostSample | null = null;
  private lastHardware: HardwareInventory | null = null;
  private lastHardwareAt = 0;
  private inFlight = false;
  private prevNetwork = new Map<string, { rx: number; tx: number; t: number }>();
  private transitionLogged = false;

  constructor(config?: any) {
    this.config = config ?? {};
  }

  async sample(): Promise<HostSample> {
    const monitoring = this.config?.monitoring ?? {};
    if (monitoring.enabled === false || monitoring.hostCounters === false) {
      this.available = false;
      this.reason = "host counters disabled";
      return this.lastSample ?? this.unavailableSample(this.reason);
    }
    if (process.platform !== "win32") {
      this.available = false;
      this.reason = "not windows";
      return this.unavailableSample("not windows");
    }
    if (this.inFlight) {
      return this.lastSample ?? this.unavailableSample("sample in flight");
    }
    this.inFlight = true;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", DYNAMIC_SCRIPT],
        { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const parsed = parseWindowsDynamic(stdout);
      if (!parsed) throw new Error("invalid JSON from PowerShell");
      const sample = toHostSample(parsed, this.prevNetwork, Date.now());
      this.lastSample = sample;
      this.available = true;
      this.reason = undefined as any;
      this.transitionLogged = false;
      return sample;
    } catch (e) {
      const reason = (e as Error).message?.slice(0, 200) ?? "powershell failed";
      if (!this.transitionLogged) {
        // eslint-disable-next-line no-console
        console.error("dbhub host metrics unavailable:", reason);
        this.transitionLogged = true;
      }
      this.available = false;
      this.reason = reason;
      return this.lastSample ?? this.unavailableSample(reason);
    } finally {
      this.inFlight = false;
    }
  }

  async hardware(): Promise<HardwareInventory> {
    const monitoring = this.config?.monitoring ?? {};
    if (monitoring.enabled === false || monitoring.hostCounters === false) {
      return { available: false, reason: "host counters disabled", cpu: { model: "unknown", cores: 0, logical: 0, speedMhz: 0 }, memoryModules: [], physicalDisks: [], logicalVolumes: [], nics: [], os: { caption: "", version: "" }, cachedAt: new Date().toISOString() } as any;
    }
    if (process.platform !== "win32") {
      return { available: false, reason: "not windows", cpu: { model: "unknown", cores: 0, logical: 0, speedMhz: 0 }, memoryModules: [], physicalDisks: [], logicalVolumes: [], nics: [], os: { caption: "", version: "" }, cachedAt: new Date().toISOString() };
    }
    const now = Date.now();
    if (this.lastHardware && now - this.lastHardwareAt < 60000) return this.lastHardware;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HARDWARE_SCRIPT],
        { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const parsed = parseWindowsHardware(stdout);
      if (!parsed) throw new Error("invalid JSON");
      const hw = toHardwareInventory(parsed);
      this.lastHardware = hw;
      this.lastHardwareAt = now;
      return hw;
    } catch (e) {
      const reason = (e as Error).message?.slice(0, 200) ?? "powershell failed";
      const hw: HardwareInventory = { available: false, reason, cpu: { model: "unknown", cores: 0, logical: 0, speedMhz: 0 }, memoryModules: [], physicalDisks: [], logicalVolumes: [], nics: [], os: { caption: "", version: "" }, cachedAt: new Date().toISOString() };
      this.lastHardware = hw;
      this.lastHardwareAt = now;
      return hw;
    }
  }

  private unavailableSample(reason: string): HostSample {
    return {
      available: false,
      reason,
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      cpuModel: "unknown",
      cpuCores: 0,
      cpuLogical: 0,
      cpuSpeedMhz: 0,
      loadAvg: [],
      cpuPercentTotal: null,
      cpuPercentPerCore: null,
      memoryTotalBytes: 0,
      memoryFreeBytes: 0,
      memoryUsedBytes: 0,
      swapTotalBytes: null,
      swapFreeBytes: null,
      uptimeSec: os.uptime(),
      disks: [],
      network: [],
      sampledAt: new Date().toISOString(),
    };
  }
}

export function createHostAdapter(config: any): HostAdapter {
  const enabled = config?.monitoring?.hostCounters !== false && config?.monitoring?.enabled !== false;
  if (!enabled) {
    // disabled: use generic? Prompt hostCounters. We'll still generic for basic.
  }
  if (process.platform === "win32") return new WindowsHostAdapter(config);
  const genericConfig = config;
  return {
    available: true,
    async sample() {
      if (genericConfig?.monitoring?.enabled === false || genericConfig?.monitoring?.hostCounters === false) {
        return { available: false, reason: "host counters disabled", hostname: "unknown", platform: process.platform, release: "", arch: process.arch, cpuModel: "unknown", cpuCores: 0, cpuLogical: 0, cpuSpeedMhz: 0, loadAvg: [], cpuPercentTotal: null, cpuPercentPerCore: null, memoryTotalBytes: 0, memoryFreeBytes: 0, memoryUsedBytes: 0, swapTotalBytes: null, swapFreeBytes: null, uptimeSec: 0, disks: [], network: [], sampledAt: new Date().toISOString() } as any;
      }
      const g = await (await import("./host-generic")).collectGenericHost();
      return g;
    },
    async hardware() {
      if (genericConfig?.monitoring?.enabled === false || genericConfig?.monitoring?.hostCounters === false) {
        return { available: false, reason: "host counters disabled", cpu: { model: "unknown", cores: 0, logical: 0, speedMhz: 0 }, memoryModules: [], physicalDisks: [], logicalVolumes: [], nics: [], os: { caption: "", version: "" }, cachedAt: new Date().toISOString() } as any;
      }
      return (await import("./host-generic")).collectGenericHardware();
    },
  };
}

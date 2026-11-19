import { describe, expect, it } from "vitest";
import { mdnsHostname } from "../src/services/mdns";
import { sanitizeSerial } from "../src/services/endpoints";
import { CloudflareTunnelProvider } from "../src/services/cloudflare-tunnel";
import { resolveEndpoints, listLanIps } from "../src/services/endpoints";

describe("appliance units", () => {
  it("sanitizes serial", () => {
    expect(sanitizeSerial("ABC 123!")).toBe("abc-123");
    expect(sanitizeSerial("")).toBe("dbhub");
  });
  it("mdns conflict suffix", () => {
    const existing = new Set(["dbhub-abc.local"]);
    expect(mdnsHostname("abc", existing)).toBe("dbhub-abc-2.local");
  });
  it("cloudflare provider missing binary", async () => {
    const cfg: any = {
      connectivity: { mode: "cloudflare", publicUrl: "https://x", cloudflare: { binaryPath: "/no/such/cloudflared", tunnelTokenFile: "", autoStart: false } },
    };
    const provider = new CloudflareTunnelProvider({ config: cfg, existsFn: () => false });
    const state = await provider.start();
    expect(state.status).toBe("not_installed");
  });
  it("cloudflare provider connected with fake spawn", async () => {
    const cfg: any = {
      connectivity: { mode: "cloudflare", publicUrl: "https://x", cloudflare: { binaryPath: "cloudflared", tunnelTokenFile: "/tmp/token", autoStart: false } },
    };
    const fakeProc: any = {
      pid: 123,
      stdout: { on: (e: string, cb: any) => { if (e === "data") setTimeout(() => cb(Buffer.from("registered")), 10); } },
      stderr: { on: () => {} },
      on: (e: string, cb: any) => { if (e === "exit") {} },
      kill: () => {},
    };
    const provider = new CloudflareTunnelProvider({
      config: cfg,
      existsFn: () => true,
      readTokenFn: () => "token",
      spawnFn: () => fakeProc,
    });
    const state = await provider.start();
    expect(["starting", "connected"]).toContain(state.status);
    await new Promise((r) => setTimeout(r, 50));
    expect(provider.getStatus().status).toBe("connected");
  });
  it("endpoints exclude loopback", () => {
    const cfg: any = { port: 8787, connectivity: { publicUrl: "https://wan" } };
    const ep = resolveEndpoints(cfg, "serial", "dbhub-serial.local");
    expect(ep.lan.every((e) => !e.url.includes("127.0.0.1"))).toBe(true);
    expect(ep.wan?.url).toBe("https://wan");
  });
});
import { describe, expect, it, vi } from "vitest";
import { makeCtx } from "./helpers";
import { startServices } from "../src/server";

describe("startup wiring", () => {
  it("mdns start/stop under flag", async () => {
    const ctx = makeCtx();
    const fakeMdns = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    const fakeTunnel = { start: vi.fn().mockResolvedValue({}), stop: vi.fn().mockResolvedValue({}) };
    ctx.config.connectivity = { mode: "lan", mdns: { enabled: true }, cloudflare: { autoStart: false } };
    const handles = await startServices(ctx.config, ctx.db, { warn: () => {} }, {
      MdnsService: function () { return fakeMdns; },
      CloudflareTunnelProvider: function () { return fakeTunnel; },
    });
    expect(fakeMdns.start).toHaveBeenCalledOnce();
    await handles.mdns.stop();
    expect(fakeMdns.stop).toHaveBeenCalled();
    ctx.cleanup();
  });

  it("mdns disabled", async () => {
    const ctx = makeCtx();
    const fakeMdns = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
    const fakeTunnel = { start: vi.fn(), stop: vi.fn() };
    ctx.config.connectivity = { mode: "lan", mdns: { enabled: false }, cloudflare: { autoStart: false } };
    await startServices(ctx.config, ctx.db, { warn: () => {} }, {
      MdnsService: function () { return fakeMdns; },
      CloudflareTunnelProvider: function () { return fakeTunnel; },
    });
    expect(fakeMdns.start).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it("tunnel start when mode+autoStart", async () => {
    const ctx = makeCtx();
    const fakeMdns = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
    const fakeTunnel = { start: vi.fn().mockResolvedValue({}), stop: vi.fn().mockResolvedValue({}) };
    ctx.config.connectivity = { mode: "cloudflare", publicUrl: "https://x", mdns: { enabled: false }, cloudflare: { autoStart: true } };
    await startServices(ctx.config, ctx.db, { warn: () => {} }, {
      MdnsService: function () { return fakeMdns; },
      CloudflareTunnelProvider: function () { return fakeTunnel; },
    });
    expect(fakeTunnel.start).toHaveBeenCalledOnce();
    ctx.cleanup();
  });

  it("tunnel not started when autoStart false", async () => {
    const ctx = makeCtx();
    const fakeMdns = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
    const fakeTunnel = { start: vi.fn(), stop: vi.fn() };
    ctx.config.connectivity = { mode: "cloudflare", publicUrl: "https://x", mdns: { enabled: false }, cloudflare: { autoStart: false } };
    await startServices(ctx.config, ctx.db, { warn: () => {} }, {
      MdnsService: function () { return fakeMdns; },
      CloudflareTunnelProvider: function () { return fakeTunnel; },
    });
    expect(fakeTunnel.start).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it("public listener not bound in lan mode", async () => {
    const ctx = makeCtx();
    const fakeMdns = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };
    const fakeTunnel = { start: vi.fn(), stop: vi.fn() };
    ctx.config.connectivity = { mode: "lan", mdns: { enabled: false }, cloudflare: { autoStart: false } };
    const handles = await startServices(ctx.config, ctx.db, { warn: () => {} }, {
      MdnsService: function () { return fakeMdns; },
      CloudflareTunnelProvider: function () { return fakeTunnel; },
    });
    expect(handles.publicServer).toBeNull();
    ctx.cleanup();
  });

  it("mdns error does not crash", async () => {
    const ctx = makeCtx();
    const fakeMdns = { start: vi.fn().mockRejectedValue(new Error("boom")), stop: vi.fn(), on: vi.fn() };
    const fakeTunnel = { start: vi.fn(), stop: vi.fn() };
    ctx.config.connectivity = { mode: "lan", mdns: { enabled: true }, cloudflare: { autoStart: false } };
    await expect(startServices(ctx.config, ctx.db, { warn: () => {} }, {
      MdnsService: function () { return fakeMdns; },
      CloudflareTunnelProvider: function () { return fakeTunnel; },
    })).resolves.toBeTruthy();
    ctx.cleanup();
  });
});
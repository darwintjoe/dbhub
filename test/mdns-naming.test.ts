import { describe, expect, it } from "vitest";
import { sanitizeSerial } from "../src/services/endpoints";
import { mdnsHostname } from "../src/services/mdns";

describe("mdns naming", () => {
  it("sanitizes hub_<uuid>", () => {
    const out = sanitizeSerial("hub_123e4567-e89b-12d3-a456-426614174000");
    expect(out).toMatch(/^[a-z0-9-]+$/);
    expect(out.startsWith("-")).toBe(false);
    expect(out.endsWith("-")).toBe(false);
  });
  it("truncates >63", () => {
    const out = sanitizeSerial("a".repeat(100));
    expect(out.length).toBeLessThanOrEqual(63);
  });
  it("conflict suffix", () => {
    const existing = new Set(["dbhub-abc.local"]);
    expect(mdnsHostname("abc", existing)).toBe("dbhub-abc-2.local");
  });
  it("empty fallback", () => {
    expect(sanitizeSerial("!!!")).toBe("dbhub");
  });
});
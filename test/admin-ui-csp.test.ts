import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ADMIN = path.resolve(process.cwd(), "public", "admin");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|mjs|html|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("admin UI CSP safety", () => {
  it("loads only self-hosted external scripts and styles", () => {
    const html = fs.readFileSync(path.join(ADMIN, "index.html"), "utf8");
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    // no external asset hosts
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/i);
  });

  it("keeps the admin CSP strict", () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), "src", "app.ts"), "utf8");
    expect(app).toContain("script-src 'self'");
    expect(app).toContain("style-src 'self'");
    expect(app).not.toContain("unsafe-inline");
  });

  it("never mutates inline style attributes from JavaScript", () => {
    const files = walk(ADMIN).filter((f) => /\.(js|mjs)$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, path.relative(ADMIN, file)).not.toMatch(/\.style\s*\./);
      expect(src, path.relative(ADMIN, file)).not.toMatch(/\bsetAttribute\(\s*["']style["']/i);
      expect(src, path.relative(ADMIN, file)).not.toMatch(/\bdocument\.write\b/);
      expect(src, path.relative(ADMIN, file)).not.toMatch(/\beval\s*\(/);
    }
  });

  it("does not write untrusted values through innerHTML", () => {
    const files = walk(ADMIN).filter((f) => /\.(js|mjs)$/.test(f));
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      // No innerHTML assignments remain after the redesign.
      expect(src, path.relative(ADMIN, file)).not.toMatch(/\.innerHTML\s*=/);
    }
  });

  it("serves all required asset modules", () => {
    const required = [
      "app.js", "api.js", "charts.js", "demo.js", "demo-api.js", "styles.css",
      "lib/format.js", "lib/status.js", "lib/score.js", "lib/dom.js",
      "views/overview.js", "views/monitoring.js", "views/devices.js",
      "views/quarantine.js", "views/config.js", "views/logs.js",
      "views/maintenance.js", "views/connect.js", "views/network.js", "views/setup.js",
    ];
    for (const rel of required) expect(fs.existsSync(path.join(ADMIN, rel)), rel).toBe(true);
  });
});

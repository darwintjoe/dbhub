import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configCandidates,
  createPlatformPaths,
  cwdConfigPath,
  defaultConfigPath,
  defaultDataDir,
  defaultLogDir,
  defaultReplicaDir,
} from "../src/platform/paths";
import { resolveConfigPath } from "../src/config";

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbhub-paths-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("platform paths (win32 injection)", () => {
  const win = { platform: "win32", cwd: "C:\\work\\dbhub", env: {} };

  it("uses PROGRAMDATA with the original C:\\ProgramData fallback", () => {
    expect(defaultConfigPath(win)).toBe("C:\\ProgramData\\DBHub\\config.json");
    expect(defaultConfigPath({ ...win, env: { PROGRAMDATA: "D:\\ProgramData" } }))
      .toBe("D:\\ProgramData\\DBHub\\config.json");
  });

  it("derives data, log, and replica defaults", () => {
    expect(defaultDataDir(win)).toBe("C:\\ProgramData\\DBHub\\data");
    expect(defaultLogDir(win)).toBe("C:\\ProgramData\\DBHub\\logs");
    expect(defaultReplicaDir(win)).toBe("C:\\ProgramData\\DBHub\\data\\replica");
  });

  it("keeps config candidate order: DBHUB_CONFIG, system config, cwd", () => {
    expect(configCandidates({ ...win, env: { DBHUB_CONFIG: "E:\\custom.json" } })).toEqual([
      "E:\\custom.json",
      "C:\\ProgramData\\DBHub\\config.json",
      "C:\\work\\dbhub\\config.json",
    ]);
    expect(configCandidates(win)).toEqual([
      "C:\\ProgramData\\DBHub\\config.json",
      "C:\\work\\dbhub\\config.json",
    ]);
  });

  it("reports the cwd config path", () => {
    expect(cwdConfigPath(win)).toBe("C:\\work\\dbhub\\config.json");
  });
});

describe("platform paths (linux injection)", () => {
  const linux = { platform: "linux", cwd: "/work/dbhub", env: {} };

  it("uses POSIX system defaults and ignores PROGRAMDATA", () => {
    expect(defaultConfigPath({ ...linux, env: { PROGRAMDATA: "C:\\ProgramData" } }))
      .toBe("/etc/dbhub/config.json");
    expect(defaultDataDir(linux)).toBe("/var/lib/dbhub");
    expect(defaultLogDir(linux)).toBe("/var/log/dbhub");
    expect(defaultReplicaDir(linux)).toBe("/var/lib/dbhub/replica");
  });

  it("keeps config candidate order: DBHUB_CONFIG, system config, cwd", () => {
    expect(configCandidates({ ...linux, env: { DBHUB_CONFIG: "/custom/dbhub.json" } })).toEqual([
      "/custom/dbhub.json",
      "/etc/dbhub/config.json",
      "/work/dbhub/config.json",
    ]);
    expect(configCandidates(linux)).toEqual([
      "/etc/dbhub/config.json",
      "/work/dbhub/config.json",
    ]);
  });

  it("binds deps through the factory", () => {
    const bound = createPlatformPaths({ platform: "linux", env: {}, cwd: "/srv/dbhub" });
    expect(bound.defaultConfigPath()).toBe("/etc/dbhub/config.json");
    expect(bound.cwdConfigPath()).toBe("/srv/dbhub/config.json");
    expect(bound.configCandidates({ env: { DBHUB_CONFIG: "/x.json" } })).toEqual([
      "/x.json",
      "/etc/dbhub/config.json",
      "/srv/dbhub/config.json",
    ]);
  });
});

describe("config path resolution uses the platform helper", () => {
  it("honors DBHUB_CONFIG injection", () => {
    const dir = tmpDir();
    const configFile = path.join(dir, "config.json");
    fs.writeFileSync(configFile, "{}");
    expect(resolveConfigPath({ env: { DBHUB_CONFIG: configFile } })).toBe(path.resolve(configFile));
  });

  it("falls back to ./config.json in the injected cwd", () => {
    const dir = tmpDir();
    const configFile = path.join(dir, "config.json");
    fs.writeFileSync(configFile, "{}");
    // Redirect PROGRAMDATA so a real system config cannot win the precedence.
    const env = { PROGRAMDATA: path.join(dir, "no-programdata") };
    expect(resolveConfigPath({ env, cwd: dir })).toBe(path.resolve(configFile));
  });
});

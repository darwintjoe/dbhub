"use strict";

// Single source of truth for platform filesystem defaults.
// Plain CJS on purpose: shared by core (via paths.ts), Node .mjs scripts,
// and the Windows-only service installer. Contains no shell/service calls.

const path = require("node:path");

const WINDOWS_PROGRAMDATA_FALLBACK = "C:\\ProgramData";

function resolveDeps(deps) {
  const d = deps || {};
  return {
    platform: d.platform || process.platform,
    env: d.env || process.env,
    cwd: d.cwd || process.cwd(),
  };
}

function isWindows(d) {
  return d.platform === "win32";
}

function pathApi(d) {
  return isWindows(d) ? path.win32 : path.posix;
}

function programData(d) {
  return d.env.PROGRAMDATA || WINDOWS_PROGRAMDATA_FALLBACK;
}

function appBase(d) {
  const P = pathApi(d);
  return isWindows(d)
    ? P.join(programData(d), "DBHub")
    : P.join("/var", "lib", "dbhub");
}

/** Config file candidates, in priority order. DBHUB_CONFIG wins, then the
 * platform system location, then ./config.json in the current directory. */
function configCandidates(deps) {
  const d = resolveDeps(deps);
  const P = pathApi(d);
  const out = [];
  if (d.env.DBHUB_CONFIG) out.push(d.env.DBHUB_CONFIG);
  out.push(defaultConfigPath(d));
  out.push(P.resolve(d.cwd, "config.json"));
  return out;
}

function cwdConfigPath(deps) {
  const d = resolveDeps(deps);
  return pathApi(d).resolve(d.cwd, "config.json");
}

/** Resolve a candidate with the same path semantics used to build it. */
function resolvePath(candidate, deps) {
  const d = resolveDeps(deps);
  return pathApi(d).resolve(candidate);
}

function defaultConfigPath(deps) {
  const d = resolveDeps(deps);
  const P = pathApi(d);
  return isWindows(d)
    ? P.join(programData(d), "DBHub", "config.json")
    : P.join("/etc", "dbhub", "config.json");
}

function defaultDataDir(deps) {
  const d = resolveDeps(deps);
  return isWindows(d) ? pathApi(d).join(appBase(d), "data") : appBase(d);
}

function defaultLogDir(deps) {
  const d = resolveDeps(deps);
  return isWindows(d)
    ? pathApi(d).join(appBase(d), "logs")
    : pathApi(d).join("/var", "log", "dbhub");
}

function defaultReplicaDir(deps) {
  const d = resolveDeps(deps);
  return pathApi(d).join(defaultDataDir(d), "replica");
}

/** Return a set of functions bound to fixed deps (convenience for consumers). */
function createPlatformPaths(deps) {
  const bind = (fn) => (override) => fn({ ...(deps || {}), ...(override || {}) });
  return {
    configCandidates: bind(configCandidates),
    cwdConfigPath: bind(cwdConfigPath),
    resolvePath: (candidate, override) => resolvePath(candidate, { ...(deps || {}), ...(override || {}) }),
    defaultConfigPath: bind(defaultConfigPath),
    defaultDataDir: bind(defaultDataDir),
    defaultLogDir: bind(defaultLogDir),
    defaultReplicaDir: bind(defaultReplicaDir),
  };
}

module.exports = {
  configCandidates,
  cwdConfigPath,
  resolvePath,
  defaultConfigPath,
  defaultDataDir,
  defaultLogDir,
  defaultReplicaDir,
  createPlatformPaths,
};

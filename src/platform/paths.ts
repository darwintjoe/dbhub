// Typed core entry point for platform filesystem defaults.
// Implementation is shared with .mjs scripts and the Windows service installer
// via paths-impl.cjs so all consumers resolve identical paths.
import impl from "./paths-impl.cjs";

export type PathDeps = {
  platform?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export type PlatformPaths = {
  configCandidates: (deps?: PathDeps) => string[];
  cwdConfigPath: (deps?: PathDeps) => string;
  resolvePath: (candidate: string, deps?: PathDeps) => string;
  defaultConfigPath: (deps?: PathDeps) => string;
  defaultDataDir: (deps?: PathDeps) => string;
  defaultLogDir: (deps?: PathDeps) => string;
  defaultReplicaDir: (deps?: PathDeps) => string;
};

export const configCandidates = (deps?: PathDeps): string[] => impl.configCandidates(deps);

export const cwdConfigPath = (deps?: PathDeps): string => impl.cwdConfigPath(deps);

export const resolvePath = (candidate: string, deps?: PathDeps): string => impl.resolvePath(candidate, deps);

export const defaultConfigPath = (deps?: PathDeps): string => impl.defaultConfigPath(deps);

export const defaultDataDir = (deps?: PathDeps): string => impl.defaultDataDir(deps);

export const defaultLogDir = (deps?: PathDeps): string => impl.defaultLogDir(deps);

export const defaultReplicaDir = (deps?: PathDeps): string => impl.defaultReplicaDir(deps);

export const createPlatformPaths = (deps?: PathDeps): PlatformPaths => impl.createPlatformPaths(deps) as PlatformPaths;

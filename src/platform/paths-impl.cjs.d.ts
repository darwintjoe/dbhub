export interface PathDeps {
  platform?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface PlatformPaths {
  configCandidates(deps?: PathDeps): string[];
  cwdConfigPath(deps?: PathDeps): string;
  resolvePath(candidate: string, deps?: PathDeps): string;
  defaultConfigPath(deps?: PathDeps): string;
  defaultDataDir(deps?: PathDeps): string;
  defaultLogDir(deps?: PathDeps): string;
  defaultReplicaDir(deps?: PathDeps): string;
  createPlatformPaths(deps?: PathDeps): PlatformPaths;
}

declare const impl: PlatformPaths;
export default impl;

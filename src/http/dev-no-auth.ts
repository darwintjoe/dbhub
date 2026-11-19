// Development-only authentication bypass. The environment variable is the sole
// gate: no config-file change is needed, and no production config opts in by default.
// WARNING: when enabled, every admin API route is open to anyone who can reach
// the listener. Never set this outside local testing.

export const DEV_NO_AUTH_ENV = "DBHUB_DEV_NO_AUTH";

// Arbitrary placeholder: CSRF verification is skipped in dev mode, but the UI
// still needs a non-empty token to treat itself as authenticated.
export const DEV_CSRF_TOKEN = "dev-noauth";

export function isDevNoAuth(): boolean {
  const raw = process.env[DEV_NO_AUTH_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

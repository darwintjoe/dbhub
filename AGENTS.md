# DBHub agent instructions

## Cross-platform memory rule

- DBHub core (`src/` except Windows-only service/metrics adapters) must run on Windows and Linux.
- Never hardcode Windows-only assumptions in core: no `C:\...` paths, no `sc.exe`/`powershell`/`netsh` calls, no backslash separators, no Windows-only env vars. Use `node:path` and a platform paths helper.
- OS-specific code belongs only in: `src/bin/service-*.cjs`, `src/services/metrics/host-windows.ts`, `scripts/install.ps1`, `scripts/uninstall.ps1`.
- Before adding a path, shell command, service call, or file mode, ask: does this work on Linux? If not, isolate it behind a platform check.
- Any new operational script must be Node `.mjs`, not PowerShell, unless it is truly Windows-only (firewall, service registration).

## Platform status

- Windows-first: Windows service install, firewall rules, and host metrics are supported today.
- Linux is planned: the core is portable, packaging (installer, systemd unit, firewall automation) is not yet built. See `docs/PLATFORM.md` for the Linux contract; do not implement it until asked.
- Platform filesystem defaults live in `src/platform/paths.ts` (typed core wrapper) backed by `src/platform/paths-impl.cjs` (shared CJS implementation used by core, `.mjs` scripts, and the Windows service installer). Inject `{ platform, env, cwd }` in tests.

## Allowed OS-specific locations

- `src/platform/paths-impl.cjs` (and typed wrapper `src/platform/paths.ts`) — the platform paths helper. It may hold platform path literals such as the `C:\ProgramData` fallback and `PROGRAMDATA` env name, but no shell/service calls. All other core code imports these functions.
- `src/bin/service-install.cjs`, `src/bin/service-uninstall.cjs` — Windows service registration (`sc.exe`, winsw, PowerShell `Start-Sleep`). May call `defaultConfigPath()` from the shared helper for the config default.
- `src/services/metrics/host-windows.ts` — Windows host counters via PowerShell. Other metrics code must stay portable (generic adapter on non-Windows).
- `scripts/install.ps1`, `scripts/uninstall.ps1` — elevated Windows install/remove, firewall (`netsh`), service control. Must be labeled Windows-only at the top.
- Everything else in `src/` and `scripts/` must use `node:path`, the platform paths helper, and platform-neutral Node APIs.

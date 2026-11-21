# Platform support contract

## Status

- **Windows-first.** The Windows service install (`scripts/install.ps1`), firewall rules, and host metrics are supported today in v0.3.x.
- **Linux is planned.** Core code (`src/`, except Windows-only service and host-metrics adapters) is portable and must run on Windows and Linux. Packaging is **not** built yet.
- This document is the Linux contract only. Do not implement the installer or unit file until explicitly asked.

## Linux target (planned, not implemented)

- Installer: `install.sh` (not yet written).
- Service: systemd unit `dbhub.service` (not yet committed to the repo).
- Unit contract:
  - `User=dbhub` (dedicated, unprivileged service account; no root runtime).
  - `WorkingDirectory=<install root>` (directory containing `dist/`).
  - `Environment=DBHUB_CONFIG=/etc/dbhub/config.json`.
  - `Restart=always`.
  - `After=network-online.target` (with `Wants=network-online.target`).
  - `ExecStart=/usr/bin/node <install root>/dist/server.js`.
- Config is read through `DBHUB_CONFIG`; the core config candidate order is:
  1. `DBHUB_CONFIG`
  2. `/etc/dbhub/config.json`
  3. `./config.json` (cwd fallback)
- No firewall automation, no `sc.exe`/`netsh`/PowerShell calls in core or in Linux operational scripts.

## Paths (Linux)

| Purpose | Path |
| --- | --- |
| Config | `/etc/dbhub/config.json` |
| Config dir | `/etc/dbhub` |
| Data | `/var/lib/dbhub` |
| Replica | `/var/lib/dbhub/replica` |
| Logs | `/var/log/dbhub` |

Ownership: `dbhub:dbhub` for data, replica, and log directories. Config file must not be world-readable (admin token hash and tunnel token file references live there). The one-time setup-code file written by `scripts/setup-code.mjs` must stay mode `0600`.

Windows equivalents (unchanged, from `src/platform/paths.ts`): config `%PROGRAMDATA%\DBHub\config.json` (fallback `C:\ProgramData`), data `...\DBHub\data`, logs `...\DBHub\logs`.

## Ports

| Port | Protocol | Bind | Purpose |
| --- | --- | --- | --- |
| 8787 | TCP | LAN / `0.0.0.0` | Local API + admin UI |
| 5353 | UDP | LAN | mDNS advertisement (`dbhub-<serial>.local`) |
| 8788 | TCP | `127.0.0.1` only | Public listener behind a tunnel |

## Prerequisites

- Node 22 LTS.
- `better-sqlite3` native build tools when a prebuilt binary is unavailable: `python3`, `make`, `g++` (plus a C++ toolchain).
- `cloudflared` on `PATH` for cloudflare tunnel mode (not needed for LAN-only mode).
- UDP 5353 reachable on the LAN; mDNS must coexist with Avahi (port 5353 is shared, so DBHub must not bind it exclusively / must tolerate Avahi owning the socket).
- Dedicated service user `dbhub`, with write access to data, replica, and log paths and read access to config.
- Setup-code file must remain `0600`.

## Explicit non-goals (for now)

- No Linux installer (`install.sh`) and no Linux uninstall script.
- No systemd unit file committed.
- No firewall automation on Linux (no ufw/firewalld changes).
- No change to the Windows install, its paths, or its service registration.
- No Linux service start/stop or journal verification has been executed; Linux is dev-only at HEAD `d84feb6`.

## Configuration and secret files (current)

- Core is portable: no `sc.exe`, `powershell`, `netsh`, or backslash paths in `src/`. OS-specific code stays in the existing allowed adapters.
- Opt-in secrets live outside SQLite: `saas.deviceTokenFile` and `googleDrive.tokenPath` (both resolved relative to the config file). Both must be mode `0600` on POSIX.
- `googleDrive.scopes` accepts only `https://www.googleapis.com/auth/drive.file`; any other scope is rejected at config parse time.
- `storage.adapter` selects `null` (default), `memory`, `local-folder`, or `google-drive`. Google Drive is opt-in and tested against a fake API only; no token is committed.

## Verification at this HEAD

`npm test` 198/198, `npm run build` pass, `npm run simulate` `SIMULATION PASSED` (`verify checked=300`), `npm audit --omit=dev` 0 vulnerabilities. None of these require a Linux service.

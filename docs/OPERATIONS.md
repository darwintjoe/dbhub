# Operations

## Requirements

- Windows 10/11 x64
- **Node.js 22 LTS in production** (v0.2.0 target). Node 24 dev host is supported for building/testing only.
- Elevated PowerShell for install/uninstall

## Install

```powershell
cd C:\path\to\dbhub
.\scripts\install.ps1
sc.exe query DBHub
curl http://localhost:8787/healthz
```

The script: `npm ci`, `npm run build`, creates `C:\ProgramData\DBHub\{data,logs}`, generates `config.json` if missing (prints admin token once), installs/starts the service, sets recovery actions, and opens TCP 8787 in Windows Firewall.

Config path order:
1. `DBHUB_CONFIG`
2. `%PROGRAMDATA%\DBHub\config.json`
3. `./config.json`

Dev quick start:

```bash
npm ci
npm run config:init
npm run dev
```

`config:init` prints the admin token once. Dev may use token `dev-admin-token` only if its hash is configured; never in production.

## Service account

Default: LocalSystem. To run as a dedicated local user:

1. Create local user, e.g. `DBHubSvc`.
2. Grant read/write on `C:\ProgramData\DBHub` and all child folders.
3. Open `services.msc`, DBHub > Log On > This account.
4. Restart service.

The account needs read/write on data, logs, and config. Firewall needs admin rights only at install time.

## Firewall

```cmd
netsh advfirewall firewall add rule name="DBHub" dir=in action=allow protocol=TCP localport=8787
```

Remove with:

```cmd
netsh advfirewall firewall delete rule name="DBHub"
```

## Upgrade

1. Stop service: `npm run service:stop`.
2. Backup data (below).
3. Replace source, run `npm ci && npm run build`.
4. Start service: `npm run service:start`.
5. Check `/healthz` and `/api/v1/status`.

Migrations are ordered and applied via `PRAGMA user_version`; re-opening an up-to-date DB is a no-op. v1 → v2 adds `accepted_seq`, outbox leases, and event reservations, and performs a one-time chain rehash. v3 cleans the v0.1.0 event leaks and backfills reservations, so old pending bundles resume normal resolution instead of quarantining as `duplicate_event`. **Replica re-export is still required after upgrading from v0.1.0 because v2 rehashed the chain.**

Moving the install directory requires `.\scripts\uninstall.ps1` then `.\scripts\install.ps1` from the new path; the service stores absolute `script` and `workingDirectory` values.

## Backup and restore

Never copy `hub.sqlite` while the service is writing. WAL means the main file alone is not a consistent snapshot. Use this procedure:

```powershell
npm run service:stop
# checkpoint WAL into the main database
node -e "const D=require('better-sqlite3');const d=new D('C:\\ProgramData\\DBHub\\data\\hub.sqlite');d.pragma('wal_checkpoint(TRUNCATE)');d.close();"
Copy-Item C:\ProgramData\DBHub\data\hub.sqlite C:\backup\ -Force
Copy-Item C:\ProgramData\DBHub\config.json C:\backup\ -Force
npm run service:start
```

Restore: stop the service, copy the saved `hub.sqlite` (and matching `config.json`) back, then start and verify `/healthz`, `/api/v1/status`, and chain verify. Do not restore a newer DB into an older binary that lacks its migrations.

## Node upgrade / better-sqlite3 rebuild

`better-sqlite3` is native. After upgrading Node:

```bash
npm rebuild better-sqlite3
npm test
npm run build
```

If prebuilt binaries are unavailable, install Visual Studio Build Tools with "Desktop development with C++".

## Troubleshooting

- `sc query DBHub` not RUNNING: `sc queryex DBHub`, check logs in `C:\ProgramData\DBHub\logs\hub-YYYY-MM-DD.log`.
- Config error at startup: ensure `adminTokenHash` is 64 lowercase hex and data/log dirs writable.
- Devices get 401: token wrong or device recreated (tokens shown once).
- Bundles pending forever: parent not yet posted; after `pendingParentTimeoutMs` they quarantine as `missing_parent`.
- Chain verify fails: use admin quarantine/detail, restore from backup; do not edit DB manually except in a test copy.

## Crash / restart test

1. Start service, run `npm run simulate` against it.
2. Mid-run: `Restart-Service DBHub`.
3. After simulator exits, check `/api/v1/status`: accepted count should match expected, no duplicates, chain verify OK, manifest latest matches.

Service auto-restart uses node-windows (`maxRestarts:10`, `wait:2`, `grow:0.25`) plus `sc.exe failure` actions restart at 5s/10s/30s.

## Acceptance record (2026-11-18)

- Version: 0.2.0 (commit eb95164)
- Node.js: 22.23.5 (portable user-level install; production target met for verification)
- npm: 10.9.9
- Rename check: zero case-insensitive `fazai` matches in tracked/untracked project files (excluding node_modules, dist, .git)
- Tests: 61/61 passed
- Typecheck: `npx tsc -p tsconfig.json --noEmit` passed
- Build: `npm run build` passed
- Simulator: `npm run simulate` -> `SIMULATION PASSED` (accepted 300, quarantined 1, pulled/checked 300)
- Service DBHub: NOT installed in this environment (no administrator elevation available); application process verified manually via `node dist/server.js` with `DBHUB_CONFIG=C:\ProgramData\DBHub\config.json`
- Config/data/logs: `C:\ProgramData\DBHub\{config.json,data,logs,replica}` (folder replica target used)
- Auto-start after reboot: not executed (service not installed)
- Crash auto-restart: not executed (service not installed)
- Graceful restart/WAL checkpoint: manual process stop/start passed; `wal_checkpoint(TRUNCATE)` returned busy=0
- LAN client push/pull: local smoke passed (device created, one accepted bundle, pull ordered by acceptedSeq, chain verify checked 1); second-LAN-PC leg not executed
- Backup/restore drill: passed (checkpoint, copy, restore, status counts and chain verify matched; original DB retained as `hub.sqlite.pre-restore` until drill passed)
- Deviations: Node installed per-user instead of system-wide; Windows service, reboot, and crash-restart acceptance steps could not be executed without elevation. Run `scripts/install.ps1` from an elevated PowerShell to complete those steps.
- Deferred issues remain: pull response omits full bundle fields; zod advisory; rate limiter scans all buckets; duplicated version string; BUNDLE-006 overloaded; folder replica filenames sort by hubSeq; v3 defensive branches lack dedicated tests.

## v0 limitations / gaps

- Dashboard at `/` has **no authentication**. Do not expose to untrusted networks. It never displays payloads or tokens.
- LAN plaintext HTTP only. **No TLS** in v0. Use a trusted LAN or terminate TLS externally.
- Bundle `signature` field reserved and ignored. No bundle signatures/authenticity yet.
- No outbound network calls (no SaaS, S3/R2, Drive, tunnel, telemetry). Replica targets are local only (`null`, `folder`).
- One company per hub instance. Multi-company/multi-hub not supported.

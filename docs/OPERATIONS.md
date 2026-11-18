# Operations

## Requirements

- Windows 10/11 x64
- Node.js 20 LTS or 22 LTS in production (this workspace built on Node 24; pin 20/22 on target hosts)
- Elevated PowerShell for install/uninstall

## Install

```powershell
cd C:\path\to\fazai-hub
.\scripts\install.ps1
sc.exe query FazaiHub
curl http://localhost:8787/healthz
```

The script: `npm ci`, `npm run build`, creates `C:\ProgramData\FazaiHub\{data,logs}`, generates `config.json` if missing (prints admin token once), installs/starts the service, sets recovery actions, and opens TCP 8787 in Windows Firewall.

Config path order:
1. `FAZAI_HUB_CONFIG`
2. `%PROGRAMDATA%\FazaiHub\config.json`
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

1. Create local user, e.g. `FazaiSvc`.
2. Grant read/write on `C:\ProgramData\FazaiHub` and all child folders.
3. Open `services.msc`, FazaiHub > Log On > This account.
4. Restart service.

The account needs read/write on data, logs, and config. Firewall needs admin rights only at install time.

## Firewall

```cmd
netsh advfirewall firewall add rule name="Fazai Hub" dir=in action=allow protocol=TCP localport=8787
```

Remove with:

```cmd
netsh advfirewall firewall delete rule name="Fazai Hub"
```

## Upgrade

1. Stop service: `npm run service:stop`.
2. Backup data (below).
3. Replace source, run `npm ci && npm run build`.
4. Start service: `npm run service:start`.
5. Check `/healthz` and `/api/v1/status`.

Migrations are ordered and applied via `PRAGMA user_version`; re-opening an up-to-date DB is a no-op.

## Backup

Stop service or use SQLite backup while running (WAL). Simplest safe copy:

```powershell
npm run service:stop
Copy-Item C:\ProgramData\FazaiHub\data\hub.sqlite* C:\backup\ -Force
npm run service:start
```

Also back up `C:\ProgramData\FazaiHub\config.json` (contains token hashes, not tokens).

## Rollback

1. Stop service.
2. Restore `hub.sqlite`, `hub.sqlite-wal`, `hub.sqlite-shm`, and prior `config.json`.
3. Restore prior `dist` or source, rebuild.
4. Start service and verify.

Do not restore a newer DB into an older binary that lacks its migrations.

## Node upgrade / better-sqlite3 rebuild

`better-sqlite3` is native. After upgrading Node:

```bash
npm rebuild better-sqlite3
npm test
npm run build
```

If prebuilt binaries are unavailable, install Visual Studio Build Tools with "Desktop development with C++".

## Troubleshooting

- `sc query FazaiHub` not RUNNING: `sc queryex FazaiHub`, check logs in `C:\ProgramData\FazaiHub\logs\hub-YYYY-MM-DD.log`.
- Config error at startup: ensure `adminTokenHash` is 64 lowercase hex and data/log dirs writable.
- Devices get 401: token wrong or device recreated (tokens shown once).
- Bundles pending forever: parent not yet posted; after `pendingParentTimeoutMs` they quarantine as `missing_parent`.
- Chain verify fails: use admin quarantine/detail, restore from backup; do not edit DB manually except in a test copy.

## Crash / restart test

1. Start service, run `npm run simulate` against it.
2. Mid-run: `Restart-Service FazaiHub`.
3. After simulator exits, check `/api/v1/status`: accepted count should match expected, no duplicates, chain verify OK, manifest latest matches.

Service auto-restart uses node-windows (`maxRestarts:10`, `wait:2`, `grow:0.25`) plus `sc.exe failure` actions restart at 5s/10s/30s.

## v0 limitations / gaps

- Dashboard at `/` has **no authentication**. Do not expose to untrusted networks. It never displays payloads or tokens.
- LAN plaintext HTTP only. **No TLS** in v0. Use a trusted LAN or terminate TLS externally.
- Bundle `signature` field reserved and ignored. No bundle signatures/authenticity yet.
- No outbound network calls (no SaaS, S3/R2, Drive, tunnel, telemetry). Replica targets are local only (`null`, `folder`).
- One company per hub instance. Multi-company/multi-hub not supported.

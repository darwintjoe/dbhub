# Operations

## Requirements

- Windows 10/11 x64
- **Node.js 22 LTS** (v0.3.0 target). Verification host ran Node v22.22.1 / npm 11.12.0.
- Elevated PowerShell for install/uninstall

## Install

Windows Services displays the display name `DBHub`, but the command-line service ID is `dbhub.exe`.

```powershell
cd C:\path\to\dbhub
.\scripts\install.ps1
sc.exe query dbhub.exe
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

Migrations are ordered and applied via `PRAGMA user_version`; re-opening an up-to-date DB is a no-op. v1 → v2 adds `accepted_seq`, outbox leases, and event reservations, and performs a one-time chain rehash. v3 cleans the v0.1.0 event leaks and backfills reservations. v4–v5 add appliance setup/session/pairing state. v6 adds the `issued_numbers` ledger and quota columns for the Hub number relay, so old pending bundles resume normal resolution instead of quarantining as `duplicate_event`. **Replica re-export is still required after upgrading from v0.1.0 because v2 rehashed the chain.**

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

- `sc.exe query dbhub.exe` not RUNNING: `sc.exe queryex dbhub.exe`, check logs in `C:\ProgramData\DBHub\logs\hub-YYYY-MM-DD.log`.
- Config error at startup: ensure `adminTokenHash` is 64 lowercase hex and data/log dirs writable.
- Devices get 401: token wrong or device recreated (tokens shown once).
- Bundles pending forever: parent not yet posted; after `pendingParentTimeoutMs` they quarantine as `missing_parent`.
- Chain verify fails: use admin quarantine/detail, restore from backup. If a recovery point exists, `POST /api/v1/admin/recovery/rebuild` restores derived data from snapshot + post-snapshot bundles + closing pack + manifest. Do not edit DB manually except in a test copy.
- New document numbers return `503 NUM-009`: replica health is CRITICAL. Review the plain-language Data Safety Score message in `/admin` before retrying.
- Replica uploads stop with "Please reconnect your Google account to continue backup.": the Drive token was revoked. Sync is paused; no technical OAuth error is shown. A real one-tap reconnect flow needs configured Google OAuth credentials.
- `/api/v1/status` `dataSafety.level` is `WARNING`: normal operations continue, but a copy is behind or no recovery point has been saved. Take a snapshot via `POST /api/v1/admin/recovery/snapshot`.

## Crash / restart test

1. Start service, run `npm run simulate` against it.
2. Mid-run: `Restart-Service dbhub.exe`.
3. After simulator exits, check `/api/v1/status`: accepted count should match expected, no duplicates, chain verify OK, manifest latest matches.

Service auto-restart uses node-windows (`maxRestarts:10`, `wait:2`, `grow:0.25`) plus `sc.exe failure` actions restart at 5s/10s/30s.

## Acceptance record (2026-11-21, HEAD d84feb6)

- Version: 0.3.0 (commit `d84feb6`, branch `hub/prd-alignment`)
- Node.js: v22.22.1; npm: 11.12.0 (WSL2 Ubuntu-26.04 dev host)
- Tests: **198/198 passed** (`npm test`, 40 files). No failures or flakes at this HEAD.
- Build: `npm run build` passed (strict TypeScript).
- Simulator: `npm run simulate` -> `SIMULATION PASSED`; `verify: {"ok":true,"checked":300}`; 3 devices, 300 accepted bundles, 1 quarantined.
- Production audit: `npm audit --omit=dev --audit-level=moderate` -> **0 vulnerabilities** (zod 4.6.7).
- Rebuild drill: `test/replica-recovery.test.ts` deletes derived events in a temp DB, rebuilds from snapshot + bundles + closing pack + manifest, and compares chain result, event count and accepted head.
- Windows service checks (previous acceptance, unchanged): service ID `dbhub.exe`, display name `DBHub`, `RUNNING`, `/healthz` ok, recovery actions 5s/10s/30s, crash and graceful restart drills passed, backup/restore drill passed.
- Not re-executed at this HEAD: auto-start after reboot, LAN push/pull from a second physical PC, Windows service install/upgrade.
- Deferred: live SaaS credentials, real Google OAuth/Drive run, real 3-device M1 recovery drill, Linux packaging, fazai client W0–W3 (other track).

## v0 limitations / gaps

- Dashboard at `/` has **no authentication**. Do not expose to untrusted networks. It never displays payloads or tokens. The `/admin` UI is session + CSRF protected.
- LAN plaintext HTTP only. **No TLS** in v0. Use a trusted LAN or terminate TLS externally.
- Bundle `signature` field reserved and ignored. No bundle signatures/authenticity yet.
- Outbound calls are opt-in: SaaS sequencing/delegated numbers and Google Drive upload require configuration and credentials. Defaults remain local-only (`null` / `folder` / memory adapters). No telemetry.
- Google Drive adapter is verified against a fake API only; no real OAuth flow executed and no token committed.
- `hub_origin` enforcement lives at the SaaS `/sync/sequence` boundary. Device→Hub uploads are accepted in hub_required mode because that path is the sanctioned relay.
- One company per hub instance. Multi-company/multi-hub not supported.
- Linux is dev-only: no installer, systemd unit, or packaging. See [PLATFORM.md](PLATFORM.md).
## Appliance setup

1. Install: `.\scripts\install.ps1` (elevated). Firewall opens TCP 8787 and UDP 5353.
2. Discover via mDNS: `dbhub-<serial>.local` advertises `_dbhub._tcp` on the admin port.
3. Generate/reset setup code: `npm run setup-code -- --data-dir <dataDir>`.
4. Complete first-run setup at `http://<ip>:8787/admin/#/setup`.
5. Pair devices with QR or short code from `/admin/#/connect`.

## Cloudflare Tunnel

- Set `connectivity.mode=cloudflare`, `connectivity.publicUrl`, and `connectivity.cloudflare.tunnelTokenFile`.
- Ensure `cloudflared` is installed at `connectivity.cloudflare.binaryPath`.
- Tunnel ingress: public hostname -> `http://127.0.0.1:8788`.
- Admin is never exposed through the tunnel.

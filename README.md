# DBHub v0.3.0

Standalone local sync hub for one company's devices. HTTP LAN ingest, SQLite replica, immutable accepted sequence chain, outbox with leases, quarantine lifecycle, pairing/QR/setup-code, read-only dashboard, and admin session + CSRF. Linux core is portable; Windows service packaging is the supported install path in v0.3.x.

The Hub is the sole replica uploader under Profile B: devices relay through the Hub and never hold storage credentials.

## Requirements

- Cross-platform core: DBHub core runs on Windows and Linux. The installer is Windows-only in v0.3.x; Linux packaging is planned and deliberately not implemented. See [docs/PLATFORM.md](docs/PLATFORM.md).
- Node 22 LTS.
- `better-sqlite3` native build tools when no prebuild is available (`python3`, `make`, `g++`).
- `cloudflared` on `PATH` for tunnel mode.
- UDP 5353 available for mDNS (coexists with Avahi on Linux).
- Elevated (Administrator) shell for Windows install.

## Quick start (dev)

```bash
npm ci
npm run config:init     # prints admin token once
npm run dev
curl http://localhost:8787/healthz
```

Admin token for dev example config can be `dev-admin-token` only if you set `adminTokenHash` to its SHA-256 hash. Never use it in production.

## Scripts

- `dev` — tsx watch
- `build` — tsc strict build to `dist`
- `start` — node `dist/server.js`
- `test` — vitest
- `config:init` — generate config + admin token
- `simulate` — 3 devices / 300 bundles e2e simulator, includes chain verification
- `verify-chain <sqlitePath>` — offline local-chain verification
- `admin-token-rotate` — recover admin token via `node scripts/admin-token-rotate.mjs`
- `service:install|uninstall|start|stop|status` — Windows service control

## Layout

- `src/domain` — canonical JSON, hashes, chain, validation
- `src/db` — migrations v1–v6 and repositories
- `src/services/replica` — `StorageAdapter` seam, memory/local-folder/null adapters, opt-in Google Drive adapter, snapshot/closing-pack/rebuild, replica health
- `src/services/saas` — metadata-only sequencer client + delegated number blocks
- `src/services/numbers` — Hub-side number relay and deferred W3 contract
- `src/http` — device/admin APIs and admin UI
- `docs/` — API, operations, design, platform, PRD alignment

Replica targets: `null` (default), `folder`, and opt-in `google-drive`. Memory/local-folder remain the defaults for tests and CI; the Google adapter is only constructed when `storage.adapter=google-drive` and config keys are supplied.

## Acceptance (HEAD d84feb6)

```bash
npm ci
npm test          # 198/198 passed
npm run build
npm run simulate  # SIMULATION PASSED, verify checked=300
npm audit --omit=dev --audit-level=moderate  # 0 vulnerabilities
```

Elevated install: `.\scripts\install.ps1`. Check: `sc.exe query dbhub.exe`.

Windows Services displays the display name `DBHub`, but the command-line service ID is `dbhub.exe`.

## Honest caveats

- Google Drive adapter is tested against a fake Google API only; no real OAuth flow was executed and no token is committed. Token file must be mode `0600`.
- Profile B `hub_origin` enforcement is implemented in the Hub sequencer client at the `/sync/sequence` boundary; device→Hub uploads are the sanctioned relay.
- Live SaaS credentials and a real 3-device Milestone 1 recovery drill (PRD §8) are still open.
- Linux is dev-only: no installer, no systemd unit, no packaging.
- PRD §19.4's direct Device→Drive fallback contradiction is resolved as: queue on Hub outage, never fall back to direct storage (PRD §10.8).

See [docs/PRD-ALIGNMENT.md](docs/PRD-ALIGNMENT.md) for the full PRD v2.2 status matrix.

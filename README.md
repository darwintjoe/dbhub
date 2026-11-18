# DBHub v0

Standalone local sync hub for one company's devices. Windows service, HTTP LAN ingest, SQLite replica, verified local chain, read-only dashboard. No outbound network calls in v0.

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
- `simulate` — 3 devices / 300 bundles e2e simulator
- `verify-chain <sqlitePath>` — offline local-chain verification
- `service:install|uninstall|start|stop|status` — Windows service control

## Layout

See `docs/` for API, operations, and design. Source: `src/{domain,db,services,http,bin}`. Repo targets: `null` (default), `folder` (dev/testing).

## Acceptance

```bash
npm ci
npm test
npm run build
npm run simulate
node scripts/verify-chain.mjs data/hub.sqlite
```

Elevated install: `.\scripts\install.ps1`. Check: `sc.exe query dbhub.exe`.

Windows Services displays the display name `DBHub`, but the command-line service ID is `dbhub.exe`.

## v0 limits

Dashboard unauthenticated, HTTP-only LAN (no TLS), signatures ignored. See `docs/OPERATIONS.md`.

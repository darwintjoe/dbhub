# Admin

DBHub admin UI is available at `/admin`. Authentication uses an HttpOnly `dbhub_admin` session cookie plus CSRF token; bearer admin token remains for CLI/automation.

## Setup code
- Generated at install/startup with >=128 bits entropy, grouped, TTL 30 minutes, max 10 attempts.
- Reset with `npm run setup-code -- --reset`.
- Never appears in structured logs.

## Development no-auth mode
- Set `DBHUB_DEV_NO_AUTH=1` to open the entire admin API without setup, password, session cookie or CSRF token. UI goes straight to the dashboard.
- Env var is the only gate; there is no config-file option and no IP restriction. Never enable outside local testing — bind `host` to `127.0.0.1` while using it.
- Startup logs a warning and first-run setup-code generation is skipped while enabled.

## mDNS discovery
- Hostname `dbhub-<serial>.local`, service `_dbhub._tcp`, TXT v/serial/company/setup/path.
- No secrets in TXT.

## Pairing
- Admin creates pairing; device claims with QR secret or short code.
- WAN claims require approval by default.
- Token returned once.

## Cloudflare Tunnel
- Public hostname -> `http://127.0.0.1:8788`.
- Admin routes return 404 on public listener.
- Tunnel token read from protected file via environment.

## Security model
- Admin plane LAN/private only.
- Public data plane only data routes.
- Remote admin off by default.
- Session cookie Secure only on HTTPS.

## Data Safety Score

The overview ribbon shows a 0–100 Data Safety Score derived from chain checks, backups, replicas, free storage and device activity. Replica health (`GOOD` / `WARNING` / `CRITICAL`) caps the score and adds a plain-language alert.

- `GOOD` — "Your records are safely stored and up to date."
- `WARNING` — "Some copies of your records are behind. Normal work can continue." Action: check the connection.
- `CRITICAL` — "Your records need a safety check before new document numbers can be issued." Action: review data safety.

User-facing strings never contain raw technical terms (hash mismatch, quarantine, replica divergence, schema incompatibility). Technical codes stay in logs and API error envelopes only.

If a Google Drive token is revoked, sync pauses and the UI says "Please reconnect your Google account to continue backup." with action "Reconnect Google Drive". No OAuth error text is shown. A real one-tap reconnect flow requires live OAuth credentials, which are not configured here.

## Number relay and recovery

- New numbers are blocked while health is `CRITICAL` (`NUM-009`); `WARNING` still issues with a plain warning in the response.
- `POST /api/v1/admin/recovery/snapshot` and `/closing-pack/:period` create recovery points; `POST /api/v1/admin/recovery/rebuild` restores derived data. See [API.md](API.md).

## Pairing encryption key
- Key source: `DBHUB_APP_SECRET` env var, else `<dataDir>/pairing.key` (32 random bytes, mode 0600, generated on first boot).
Back up `<dataDir>/pairing.key` together with `hub.sqlite`. If the key is lost, in-flight pairing sessions cannot be decrypted and are discarded on next access; stored data is unaffected and new pairings work with a freshly generated key.
- Back up this key with the database. Never store it in SQLite.
- If the key is lost, in-flight pairings become undecryptable and are treated as expired; no stored data is lost.

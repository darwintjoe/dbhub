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
EOF
## Pairing encryption key
- Key source: `DBHUB_APP_SECRET` env var, else `<dataDir>/pairing.key` (32 random bytes, mode 0600, generated on first boot).
Back up `<dataDir>/pairing.key` together with `hub.sqlite`. If the key is lost, in-flight pairing sessions cannot be decrypted and are discarded on next access; stored data is unaffected and new pairings work with a freshly generated key.
- Back up this key with the database. Never store it in SQLite.
- If the key is lost, in-flight pairings become undecryptable and are treated as expired; no stored data is lost.

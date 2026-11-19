# DBHub API v1

Base URL: `http://<host>:8787`

All responses are JSON. Errors use:

```json
{ "error": { "code": "SYNC-002", "message": "Plain language message.", "details": {} } }
```

Auth:
- Device endpoints: `Authorization: Bearer <deviceToken>`
- Admin endpoints: `Authorization: Bearer <adminToken>`
- `/healthz` is public. Dashboard `/` is public in v0 (read-only).

## Health

```bash
curl http://localhost:8787/healthz
# { "ok": true, "version": "0.3.0" }
```

## Admin: create device

```bash
curl -X POST http://localhost:8787/api/v1/admin/devices \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"KASIR-1","prefix":"KASIR1"}'
# 201 { "deviceId":"dev_...","prefix":"KASIR1","token":"fzh_...","hubUrl":"http://...:8787" }
```

Token shown once. Only its SHA-256 hash is stored. `prefix` optional (auto A, B, C...).

## Admin: list devices

```bash
curl http://localhost:8787/api/v1/admin/devices \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Admin: revoke device

```bash
curl -X POST http://localhost:8787/api/v1/admin/devices/dev_xxx/revoke \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Revoked device receives `403 AUTH-002`.

## Push bundle

```bash
curl -X POST http://localhost:8787/api/v1/relay/bundles \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d @bundle.json
```

Possible results:

```json
{ "status": "accepted", "hubSeq": 42, "chainHash": "..." }
{ "status": "pending_parent" }
{ "status": "quarantined", "reason": "hash_mismatch" }
{ "status": "duplicate", "hubSeq": 42 }
```

Errors: `BUNDLE-001` malformed/invalid content type (400/415), `BUNDLE-002` company mismatch (409), `BUNDLE-003` hash mismatch (surfaced as quarantined), `BUNDLE-004` duplicate event (quarantined), `BUNDLE-005` unsupported version, `BUNDLE-006` bundle id reused with different content (409), `BUNDLE-007` body too large (413), `AUTH-002` revoked, `AUTH-003` bundle `deviceId` does not match the authenticated device (403), `RATE-001` limited.

Maximum request body is `limits.maxBodyBytes` (default 5 MB, 5242880 bytes). Oversized bodies return `413 BUNDLE-007`.

Idempotency: retries are checked **before** any insert. Retrying a quarantined bundle returns `200 { "status": "quarantined", "reason": ... }`; retrying a still-pending bundle returns `200 { "status": "pending_parent" }`; retrying a settled accepted bundle returns `duplicate`. `duplicate` means stored and settled under the same bundle hash — never pending.

## Pull bundles

```bash
curl "http://localhost:8787/api/v1/pull?since=0&limit=200" \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

`since` is an **accepted sequence cursor**, not `hubSeq`. Returns only `accepted` bundles ordered by `accepted_seq` ASC, max `limit=200`. Each item includes both `acceptedSeq` (chain/order position) and `hubSeq` (insertion/audit order). `nextSince` is the last `acceptedSeq` returned.

## Manifest

```bash
curl http://localhost:8787/api/v1/manifest \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

## Admin: quarantine list

```bash
curl "http://localhost:8787/api/v1/admin/quarantine?limit=50&status=quarantined" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

No payload in list.

## Admin: quarantine detail (includes payload)

```bash
curl http://localhost:8787/api/v1/admin/quarantine/bdl_xxx \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Admin: verify chain

```bash
curl -X POST http://localhost:8787/api/v1/admin/maintenance/verify-chain \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# { "ok": true, "checked": 120 }
```

## Admin: checkpoint WAL

```bash
curl -X POST http://localhost:8787/api/v1/admin/maintenance/checkpoint \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# { "ok": true }
```

## Admin: outbox status

```bash
curl http://localhost:8787/api/v1/admin/outbox \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# { "counts": { "pending":0,"failed":0,"done":120,"uploading":0 }, "lastErrors": [] }
```

## Status (device or admin)

```bash
curl http://localhost:8787/api/v1/status \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

`chain.latestAcceptedSeq` is the chain head. `chain.latestHubSeq` remains the maximum insertion-order `hubSeq` and may be larger after out-of-order resolution.

## Dashboard

```bash
curl http://localhost:8787/
```

Read-only HTML. No payloads or tokens displayed.
## Appliance endpoints (additive)

### Setup and session
- `POST /api/v1/admin/setup` `{code,password,companyName,timezone}` (LAN/private IP only, one-time code)
- `POST /api/v1/admin/session` `{password}` (sets `dbhub_admin` cookie)
- `GET /api/v1/admin/session` -> `{authenticated, setupRequired, csrfToken}`
- `DELETE /api/v1/admin/session` logout

### Pairing
- `POST /api/v1/admin/pairings` `{label, role, scopes, network, requireApproval}`
- `GET /api/v1/admin/pairings/:id`
- `POST /api/v1/admin/pairings/:id/approve`
- `DELETE /api/v1/admin/pairings/:id`
- `GET /api/v1/admin/pairings/:id/qr.svg`
- `POST /api/v1/pair/claim` `{pairingId, code, device:{...}}` (both listeners)

### Connectivity
- `GET/PUT /api/v1/admin/connectivity`
- `POST /api/v1/admin/connectivity/restart`
- `POST /api/v1/admin/connectivity/rotate-token`
- `POST /api/v1/admin/connectivity/test`

### Diagnostics/bootstrap
- `GET /api/v1/admin/diagnostics`
- `GET /api/v1/admin/bootstrap`

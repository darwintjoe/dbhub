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

`dataSafety` is a plain-language health summary: `{ level: "GOOD"|"WARNING"|"CRITICAL", score, label, message, action }`. No raw integrity/storage terms are exposed here. `CRITICAL` blocks new number issuance (`503 NUM-009`); `WARNING` allows normal work.

## Number relay (device)

All endpoints require a device bearer token.

```bash
curl "http://localhost:8787/api/v1/numbers/next?doc_type=INV&prefix=A&idempotency_key=<key>" \
  -H "Authorization: Bearer $DEVICE_TOKEN"
curl -X POST http://localhost:8787/api/v1/numbers/next \
  -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"doc_type":"INV","prefix":"A","idempotency_key":"<key>"}'
```

- `POST /api/v1/numbers/block` `{doc_type,prefix,size}` -> delegated block (201).
- `GET /api/v1/numbers/block` -> `{blocks:[...]}` with issued/voided/abandoned/consumed counts.
- `GET /api/v1/numbers/block/:id` -> single block status (404 `NUM-008`).
- `POST /api/v1/numbers/reconcile` `{block_id,consumed:[],voided:[]}` -> reconciled status; closes unreported gaps as abandoned.
- `POST /api/v1/numbers/void` `{idempotency_key}` -> records a voided number.
- `POST /api/v1/numbers/abandon` `{block_id}` -> abandons a block.

Errors: `NUM-001` invalid input (400), `NUM-002` key reused for another document (400), `NUM-004` no delegated block / offline exhaustion (503), `NUM-005` quota exhausted (503), `NUM-006` voided/abandoned number replay (409), `NUM-007` non-contiguous block (400), `NUM-008` not found (404), `NUM-009` issuance paused by CRITICAL health (503).

Numbers are gapless within a prefix, never reused, and delegated from SaaS through the same machine-token client used for sequencing. The fazai-side request contract is exported in `src/services/numbers/w3-contract.ts` only; no fazai code was changed.

## Admin: recovery

Requires admin token. Uses the configured `StorageAdapter` (memory/local-folder by default; opt-in Google Drive).

- `POST /api/v1/admin/recovery/snapshot` -> `{snapshotId,uri,eventCount}` (201).
- `GET /api/v1/admin/recovery/snapshot` -> snapshot object (404 `RECOVER-002` if none).
- `POST /api/v1/admin/recovery/closing-pack/:period` (`YYYY-MM`) -> `{period,uri,hash}` (201).
- `GET /api/v1/admin/recovery/closing-pack/:period` -> closing pack object.
- `POST /api/v1/admin/recovery/rebuild` -> `{ok,snapshotId,eventsRestored,bundlesReplayed,chain,manifestValid,closingPacksValid}`; rebuilds from snapshot + post-snapshot bundles + closing pack + manifest.

Rebuild failures return `RECOVER-002` (no recovery point) or `RECOVER-003` (validation did not pass).

## SaaS boundary (Profile B)

`/sync/sequence` receives metadata only: `bundle_id`, `prev_hash`, `payload_hash`, `drive_uri`, `event_count`, `device_id`, `hub_origin`. Payload bytes never leave the Hub. In `hub_required` mode the sequencer client rejects `hub_origin=false` locally (`SAAS-003`) before any request. Device→Hub relay uploads are accepted in hub_required mode because that is the sanctioned relay path.

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

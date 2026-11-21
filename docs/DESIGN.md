# Design

## Canonical JSON

All hash inputs use canonical JSON:

- recursively sort object keys (lexicographic by JS `Object.keys().sort()`)
- no whitespace
- arrays preserve order
- UTF-8 encoding

Example: `{ "b": 1, "a": [ { "y": 2, "x": 1 } ] }` becomes
`{"a":[{"x":1,"y":2}],"b":1}`.

Tests lock key-order independence, nested objects, arrays, and unicode.

## Hash formats

All hashes are lowercase SHA-256 hex (64 chars), computed with `node:crypto`.

- `tokenHash = sha256(token)` — only hashes stored.
- `payloadHash = sha256(canonicalJson(payload))`.
- `bundleHash = sha256(canonicalJson(bundle without its own bundleHash field))`.
- `chainHash(prev, bundleHash)`:
  - if `prev === null`: `sha256(bundleHash)`
  - otherwise: `sha256(prev + ":" + bundleHash)`

The `:` separator is required by the local chain format. The first bundle has no separator because there is no previous hash. The `bundleHash` is device-provided and verified; `chain_hash` is hub-assigned.

## hub_seq vs accepted_seq vs SaaS global order

- `hub_seq` is insertion/audit order (`INTEGER PRIMARY KEY AUTOINCREMENT`). It is assigned when the row is first stored, including pending/quarantined rows. It is **not** chain order and not pull order.
- `accepted_seq` is assigned **at acceptance time**, in the same transaction, from `COALESCE(MAX(accepted_seq),0)+1`. It is contiguous, unique for accepted rows, and never changes. It is the local chain order and the `/pull` cursor.
- `global_bundle_id` receives the SaaS global sequence when a sequencer client is configured; it stays `NULL` in default local-only mode. The sequencer receives metadata only, never payload.

Why immutable: v0.1.0 rebuilt `chain_hash` for historical rows during out-of-order resolution. Those hashes had already been exported by `FolderTarget`, so replicas silently diverged. From v0.1.1 onward, `accepted_seq` and `chain_prev_hash`/`chain_hash` are written once and never rewritten. The B1 StorageAdapter seam now maps stored objects across adapters; `accepted_seq` is the local order and `global_bundle_id` the SaaS order.

## Per-device chain vs hub chain

Device-provided `devicePrevHash` is a per-device pointer. Under concurrent multi-device writes it is not a global linked list; two devices can reference the same previous bundle. The hub enforces per-device continuity only:

- first accepted bundle for device must have `devicePrevHash === null`
- subsequent bundles must have `devicePrevHash === current device head`
- otherwise: quarantine if the referenced hash already settled locally, pending if not yet seen
- the authenticated device's `deviceId` must equal `bundle.deviceId` (`AUTH-003`)

The device head is tracked in `meta` (`device_head:<deviceId>`), not derived from `hub_seq`, because pending bundles can be accepted later with a lower `hub_seq` than their parent.

Separately, every accepted bundle enters the hub-local chain ordered by `accepted_seq`:

- `chain_prev_hash` = previous accepted bundle's `chain_hash` (or null)
- `chain_hash` = hash of `chain_prev_hash:bundle_hash`

Both are written once at acceptance. `chain verify` walks accepted bundles by `accepted_seq` and recomputes this chain.

## pending_parent lifecycle

Out-of-order posts happen when a device retries bundle N+1 before N is accepted.

1. N+1 arrives, parent hash not seen: insert with `status=pending_parent`, `pending_since`, placeholder `chain_hash`, no accepted_seq, no outbox row. Its event ids go to `pending_event_ids`, **not** `events`.
2. N arrives: accepted normally, then the resolver repeatedly accepts only the pending bundle whose `clientPrevHash` equals the current device head (or `null` when the device has no head). A pending bundle whose parent merely exists somewhere is a fork and is quarantined, not accepted.
3. On resolution: `accepted_seq` is assigned, `chain_prev_hash`/`chain_hash` are written once, reservations are deleted, event ids are inserted into `events` exactly once, `pending_since` is cleared, and the bundle is enqueued to the outbox. Descendants resolve recursively.
4. If an event id was won by an accepted bundle while a pending bundle waited, the pending bundle is quarantined as `duplicate_event` and its reservations are released — no exception is thrown.
5. If the parent never arrives within `quarantine.pendingParentTimeoutMs` (default 24h), maintenance sweeps the bundle to `quarantined` reason `missing_parent` and releases its reservations.

Pending/quarantined bundles are never returned by `/pull`. `/status` counts events from `events` only, so the number is truthful.

## Outbox, leases and replica targets

Each accepted bundle creates one outbox row per configured target (`null`, `folder`, or opt-in `google-drive`). The batching loop runs every 2s, takes up to 20 due pending rows, and calls `ReplicaTarget.uploadBundle` then `uploadManifest`. When `storage.adapter=google-drive`, a `StorageAdapterTarget` bridge serializes the `StoredBundle` into bytes and calls the B1 `StorageAdapter`; legacy null/folder targets are unchanged.

- Claim is synchronous: `status='uploading'`, `lease_expires_at = now + 5 min`, before any `await`.
- `processOnce` reclaims rows whose lease expired (crash recovery), and startup resets all `uploading` rows to `pending`.
- Only one `processOnce` runs at a time; `stop()` awaits the in-flight promise before DB close.
- Leases are cleared on `done`, `failed`, and retry.

Backoff is exponential: `min(60s, 1s * 2^(attempts-1))`. After 10 attempts the row becomes `failed` with `last_error`. This proves the pipeline without network calls.

`ReplicaTarget` is retained for the legacy batching path. The B1 `StorageAdapter` is the Storage Abstraction Layer (SAL) seam: `connect`, `disconnect`, `healthCheck`, bundle snapshot/closing-pack/manifest object operations. Adapters are `MemoryAdapter`, `LocalFolderAdapter`, `NullStorageAdapter` and opt-in `GoogleDriveAdapter`. A paused adapter (revoked token) makes `StorageAdapterTarget.isPaused()` true so batching skips uploads until reconnect.

## Migrations v1 → v6

Migration v2 is additive and idempotent:

- adds `bundles.accepted_seq`, a partial unique index, and a `(device_id, status, hub_seq)` index
- adds `manifests.latest_accepted_seq`
- adds `outbox.lease_expires_at`
- adds `pending_event_ids`
- backfills existing accepted rows in `hub_seq` order, assigns `accepted_seq = 1..n`, and recomputes their chain once

Migration v3 is data-only and idempotent:

- deletes reservations not belonging to a currently pending bundle
- deletes `events` rows attached to non-accepted bundles (the v0.1.0 pending/timeout leak)
- backfills `pending_event_ids` from each remaining pending bundle's `payload_json`
- marks unparseable payloads `migration_invalid_payload` and same-payload duplicates `duplicate_event`, releasing their reservations

v3 does **not** recompute chain values; v2 already did that. Old pending bundles resume normal resolution after upgrade: their ids are reservations, not committed events.

**v2's one-time rehash still invalidates replica files produced by v0.1.0.** Delete replica folders and re-export them after upgrading even though v3 cleans the event leak.

v4–v5 add appliance setup/session/pairing state and encrypted QR payload storage. v6 adds the `issued_numbers` ledger (unique `(doc_type,prefix,number)` and `idempotency_key`) plus quota columns on `number_blocks` for the Hub number relay.

## Implemented SAL / SaaS mapping

- `global_bundle_id` holds the SaaS sequence assigned by the metadata-only `/sync/sequence` client.
- `latestSnapshotId` / `latestClosedPeriod` are written by the recovery service and uploaded with each manifest.
- `number_blocks` / `issued_numbers` back the delegated number relay; blocks stay contiguous per prefix, numbers are never reused, and void/abandoned states are recorded.
- `signature` remains reserved (ignored) — no authenticity layer yet.

## Snapshot, closing pack and rebuild

- Snapshot object: `snap-<id>.json` — projection/event references plus a chain checkpoint (`latestAcceptedSeq`, `latestHubSeq`, `latestChainHash`, bundle head).
- Closing pack: `close-YYYY-MM.json` — period checkpoint with ledger/category hashes and bundle range (PRD §25).
- Manifest: `manifest-<replicaId>.json` (adapter keys carry the replica id in JSON; the connector appends the object name).
- Rebuild (PRD §26): restore snapshot event references, replay accepted bundles after the snapshot horizon, verify the chain, validate manifest and closing pack, then return a result. The drill in `test/replica-recovery.test.ts` deletes derived `events` in a temp copy and compares chain result and status.

## Replica health and gating

Good/warning/critical levels come from chain verification, adapter health, manifest alignment, recovery-point presence and items needing review. All user-facing text is plain operational language. `CRITICAL` blocks new number issuance (`NUM-009`); `WARNING` allows work and adds a warning field.

## Google Drive adapter

Opt-in via `storage.adapter=google-drive`. Uses drive.file scope only, `appDataFolder`, object names `b-<seq padded 10>-<id>.json`, `snap-*`, `close-YYYY-MM.json`, `manifest-<replicaId>.json`. Token file is mode `0600`; refresh is silent; revocation pauses sync with a plain reconnect message. Calls are serialized per adapter (one company) and retried with exponential backoff. Tests use a fake Google API only — no real OAuth flow or token.

## SaaS boundary

`POST /sync/sequence` sends exactly seven metadata fields; payload bytes never leave the Hub. In `hub_required` mode `assertHubOriginAllowed` rejects `hub_origin=false` locally (`SAAS-003`) before any network call. Device→Hub relay uploads remain accepted in hub_required mode because that path is the sanctioned relay; direct Device→Drive fallback is deliberately not implemented (PRD §19.4 resolved as queue-not-direct).

## Security model

- Bearer tokens only; no cookies, no CSRF surface.
- Timing-safe token comparison; SHA-256 token hashes only.
- Rate limits per device token and per IP (in-memory token bucket, idle buckets evicted after 10 min, capped at 10,000 buckets).
- Body capped at 5 MB; non-JSON content types rejected (5 MB -> `413 BUNDLE-007`, wrong content type -> `415 BUNDLE-001`).
- Input schemas use zod 4.6.7; production audit is clean (GHSA-mrhx-c7xc-m3w5 remediated). Validation semantics and error codes are unchanged.
- Logs redact authorization, tokens, and payloads. No payload at info level.
- Device/Hub machine tokens and the Google refresh token live in separate `0600` files, not in SQLite or config JSON.

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

## hub_seq vs SaaS global order

`hub_seq` is a local provisional ordering (`INTEGER PRIMARY KEY AUTOINCREMENT`). It is stable and used for pull pagination and the local chain. It is **not** a global order across hubs or companies.

`global_bundle_id` is reserved (`@reserved`) and stays `NULL` in v0. A future SaaS sequencing service assigns final global order. SAL (server-assigned ledger) may later map `hub_seq -> global_bundle_id`.

## Per-device chain vs hub chain

Device-provided `devicePrevHash` is a per-device pointer. Under concurrent multi-device writes it is not a global linked list; two devices can reference the same previous bundle. The hub enforces per-device continuity only:

- first accepted bundle for device must have `devicePrevHash === null`
- subsequent bundles must have `devicePrevHash === last accepted bundleHash for that device`
- otherwise: quarantine if the referenced hash already exists locally, pending if not yet seen

Separately, every accepted bundle enters the hub-local chain ordered by `hub_seq`:

- `chain_prev_hash` = previous accepted bundle's `chain_hash` (or null)
- `chain_hash` = hash of `chain_prev_hash:bundle_hash`

`chain verify` walks accepted bundles by `hub_seq` and recomputes this chain.

## pending_parent lifecycle

Out-of-order posts happen when a device retries bundle N+1 before N is accepted.

1. N+1 arrives, parent hash not seen: insert with `status=pending_parent`, `pending_since`, placeholder `chain_hash`, no outbox row, events inserted for uniqueness.
2. N arrives: accepted normally, then the resolver scans pending bundles for that device in `hub_seq` order.
3. N+1 now has a known accepted parent: it is marked `accepted`, assigned `chain_prev_hash` from the last accepted bundle with lower `hub_seq`, `chain_hash` recomputed, `pending_since` cleared, and enqueued to outbox. Descendants resolve recursively.
4. If parent never arrives within `quarantine.pendingParentTimeoutMs` (default 24h), maintenance sweeps it to `status=quarantined`, reason `missing_parent`.

Pending/quarantined bundles are never returned by `/pull`.

## Outbox and replica targets

Each accepted bundle creates one outbox row per configured target (`null` or `folder` in v0). The batching loop runs every 2s, takes up to 20 due pending rows, and calls `ReplicaTarget.uploadBundle` then `uploadManifest`.

Backoff is exponential: `min(60s, 1s * 2^(attempts-1))`. After 10 attempts the row becomes `failed` with `last_error`. This proves the pipeline without network calls.

`ReplicaTarget` is the seam for future cloud uploads (`s3`, `drive`) and SaaS sequencing. No cloud code exists in v0.

## Future SAL / SaaS mapping

- `global_bundle_id` will hold SaaS sequence.
- Manifest fields `latestSnapshotId`, `latestClosedPeriod` are reserved for future snapshot/period closure.
- `number_blocks` reserved for v1 number relay.
- `signature` reserved for bundle authenticity.

## Security model

- Bearer tokens only; no cookies, no CSRF surface.
- Timing-safe token comparison; SHA-256 token hashes only.
- Rate limits per device token and per IP (in-memory token bucket).
- Body capped at 5 MB; non-JSON content types rejected.
- Logs redact authorization, tokens, and payloads. No payload at info level.

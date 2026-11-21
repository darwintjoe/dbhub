# PRD v2.2 -> DBHub alignment (HEAD d84feb6)

Status legend: **closed** = implemented and verified in this repo; **partial** = Hub-side code present but external/other-track work remains; **open** = not implemented here.

| PRD section | Topic | Status | Evidence / note |
| --- | --- | --- | --- |
| §5 | Storage architecture | partial | SQLite replica is working store; PRD SQLite-WASM/OPFS applies to fazai client (other track). |
| §8 | Milestone 1 Definition of Done | open | Needs real ≥3-device dogfood and recorded 15-minute recovery drill with a live Google Drive replica. |
| §9 | Official numbering | partial | Hub-side delegated block relay closed (`b89c60f`); gapless/no-reuse/void/abandon/quota/offline-exhaustion covered by tests. Device-side W3 work is the other track. |
| §10.3 / §10.8 | Profile B enforcement / no direct fallback | partial | `hub_origin` enforced at `/sync/sequence` by sequencer client; direct device→Drive fallback resolved as queue-not-direct. Live SaaS not exercised. |
| §11 | Quarantine lifecycle | closed | Pre-existing lifecycle preserved; plain-language surfacing in admin UI. |
| §12 | Tenancy / identity | open | Supabase auth and RLS live on the SaaS side; Hub verifies device tokens only. |
| §13, §14.3–§14.4 | Storage adapter / SAL | closed | `StorageAdapter` seam (`64cb9e2`) with memory/local-folder/null adapters and opt-in Google Drive adapter (`3ef15fd`). |
| §13, §14.4 | Google Drive adapter code | closed | drive.file scope only, appDataFolder, PRD object names, 0600 token file, silent refresh, revocation pause, serialized calls, backoff. **Fake API tests only.** |
| §13.3 | Token revocation UX | partial | Sync pauses; plain reconnect message/action surfaced via replica health and admin UI. One-tap reconnect flow needs live OAuth. |
| §15 | SaaS sequencer | partial | Metadata-only POST `/sync/sequence` client with idempotency key and device-token boundary (`15ea3b2`). No live SaaS credentials used. |
| §15.3 | "Push to Google Drive" contradiction | closed | Upload happens before sequencing; sequencer request contains metadata only, never payload (wire-level test). |
| §17 | Manifest per replica | closed | Manifest carries `replicaId`; B1 adapter writes it; B4 updates snapshot/closing-pack cursors. |
| §18 / §29 | Replica health, Data Safety Score | closed | GOOD/WARNING/CRITICAL with plain operational messages in `/api/v1/status`, admin overview and Data Safety Score. |
| §19.4 | Recovery contradiction | closed by decision | No direct Device→Drive fallback; devices queue on Hub outage. |
| §22 | Error surfacing / language | closed | Plain-language codes and messages; no raw hash/quarantine/divergence wording in user-facing strings. |
| §23.2 | Language rules | closed | Admin UI and health messages use plain operational language. |
| §25 | Monthly closing packs | closed | `close-YYYY-MM.json` write/read via StorageAdapter. |
| §26 | Local DB rebuild contract | closed | Snapshot + post-snapshot bundles + closing pack + manifest -> replay + chain verify + validate; recorded rebuild drill in `test/replica-recovery.test.ts`. |
| §27 | Version policy | open | PWA/version check is fazai-side (other track). |
| §28 | Schema/version compatibility | partial | Migrations v1–v6, schema/format fields tracked; client version gating is other track. |
| §29.4 | Health-gated number issuance | closed | CRITICAL blocks new numbers (`NUM-009`); WARNING allows with a warning. |
| §32 | MVP technical scope | partial | Hub scope implemented; live SaaS/Drive and Linux packaging explicitly deferred per §32/PLATFORM contract. |
| GHSA-mrhx-c7xc-m3w5 | zod advisory | closed | zod 4.6.7, production audit 0; oversized-array regression test added (`d84feb6`). |

## Open items (not in this repo)

- Live SaaS credentials: `saas.baseUrl`, profile mode, 0600 device-token file. No secrets committed.
- Real Google OAuth consent + one real Drive upload/list/delete run. Adapter currently tested against a fake API only.
- Real 3-device Milestone 1 recovery drill (§8) with measured duration < 15 min.
- fazai client W0–W3 (separate development track; never modified here).
- Linux packaging: `install.sh`, `dbhub.service`, dedicated `dbhub` user, `/etc|/var/lib|/var/log/dbhub` (stage B6, only on explicit request).

## Verification at this HEAD

`npm test` 198/198, `npm run build` pass, `npm run simulate` `SIMULATION PASSED` with `verify: {"ok":true,"checked":300}`, `npm audit --omit=dev --audit-level=moderate` → 0 vulnerabilities.

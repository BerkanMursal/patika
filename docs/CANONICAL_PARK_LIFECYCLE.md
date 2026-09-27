# Canonical Park Lifecycle & Release Import Design

Status (2026-09-27, second pass):
- **Schema, bundle exporter/validator and single-transaction importer are implemented and tested on the local DB only.** See §11.
- Nothing has been written to production. No production credentials exist in this environment.
Frozen release candidate (RC): 26,405 canonical / 413 review / 24,750 OSM-backed. It retires 66 ids: 33 aliases and 33 tombstones (30 `taxonomy_review`, 3 `non_park`).

## 1. Dependency inventory (from the migrations and the live local catalog)

Direct foreign keys to `parks.id`. Taken from `pg_constraint`, not assumed.

| Table.column | ON DELETE | Nature of rows |
|---|---|---|
| `feeding_points.park_id` | CASCADE | Infrastructure. The importer creates one general point per park with **`feeding_points.id = parks.id`** (1,979/1,981 locally) and `unique(park_id, name)` |
| `feeding_events.park_id` | NO ACTION | User content (photo, amounts, location). Also `feeding_events.point_id → feeding_points` (NO ACTION) |
| `favorites.park_id` (PK user_id, park_id) | CASCADE | User content |
| `reports.park_id` | CASCADE | Moderation history |
| `park_name_suggestions.park_id` | CASCADE | User content plus moderation history. Unique pending index `(user_id, park_id) where status='pending'` |
| `park_source_refs.park_id` | CASCADE | Provenance, PK `(source_code, external_id)` |

Indirect references:
- `observations.point_id → feeding_points` (NO ACTION).
- `point_transactions.source_id` points at feeding/observation ids, not parks, so it is unaffected.
- `rescue_cases` has no park reference.

Functions, views and policies that read `parks` (catalog query on `prosrc` and view definitions):
- View `park_summaries` (`where p.active`).
- Read RPCs: `get_parks`, `get_park` (through the view), `list_feedings` (`p.active`), `list_park_name_suggestions` (`p.active`).
- Write RPCs:
  - `suggest_park_name` and `review_park_name` (require `active`)
  - `submit_feeding` and `submit_observation` (point and park must be active)
  - `report_item`
- Moderation:
  - `resolve_report` (a hide sets `parks.active=false`)
  - `get_report_context` (no active filter)
- RLS policies `points_read`, `events_read` and storage `photos_read` (all require `p.active`).
- Trigger `preserve_reviewed_park_name` on `parks`.

Client lookup paths (read only, the mobile app was not changed):
- The deep link `patika://park/:id` leads to `get_park`.
- Favorites are read through `from('favorites')`.
- `Park` navigation receives `event.park_id` and `suggestion.park_id`.
- The only park ids cached on the device are demo-mode name suggestions in AsyncStorage.
- Importers: `scripts/import-izmir-canonical.mjs` and `scripts/import-nationwide-canonical.mjs` both do non-transactional supabase-js batch upserts.

Consequences for the design:
1. A retired id that exists in `parks` cannot be hard-deleted. The CASCADE FKs would destroy favorites, reports, suggestions and refs, and `feeding_events` would block the delete anyway. **A retired row stays in `parks` with `active=false`.** Every existing read path already filters on `active`, so it disappears from maps, search and feeds with no RPC change.
2. `parks.active=false` also means "hidden by moderation". The lifecycle tables, not the flag, decide whether an id is retired.
3. The RC was never imported. The local DB holds only the 1,981 İzmir parks. None of the 66 retired ids exist there, so retired ids are **not** FKs to `parks`.
4. The DB can contain parks that are not in the RC. Locally there are 3: 2 smoke-test fixtures, and OSM `way/600671941`, which has vanished from the current OSM snapshot. **Correction:** an earlier version of this document said `way/600671941` has 1 feeding event. That was wrong: the single local feeding event belongs to smoke fixture `a0000000-…001`. The OSM park has only its general feeding point and its OSM ref. §11 gives the generic policy for these parks.

## 2. `canonical_park_releases`
`release_id` (PK, slug), `base_snapshot_sha256`, `manifest_sha256`, `expected_counts` jsonb, `status` (`applying` | `applied`), `created_at`, `applied_at`.
It records each release so the importer can recognise one that has already been applied. Every alias and tombstone references it; this is the snapshot id.

## 3. `canonical_park_aliases`
| column | type | rule |
|---|---|---|
| `retired_park_id` | uuid PK | exactly one lifecycle record per id |
| `canonical_park_id` | uuid NOT NULL → `parks(id)` ON DELETE RESTRICT | survivor. A survivor with aliases cannot be hard-deleted |
| `reason` | text NOT NULL (1–1000) | |
| `source_code` | text, lower-case | |
| `cluster_id` | text | physical-park cluster |
| `release_id` | text NOT NULL → releases | snapshot |
| `created_at` | timestamptz | |

`CHECK (retired_park_id <> canonical_park_id)`. Deferred integrity checks run at commit and re-read the current rows:
- The survivor is a live park.
- The survivor is not itself retired, so there are no chains and therefore no cycles.
- Nothing points at a retired id. To retire a survivor, first re-point its aliases in maintenance mode.
- The retired id is not also a tombstone.
- The retired id is not active in `parks`.

## 4. `canonical_park_tombstones` and `canonical_park_tombstone_refs`
Tombstones: `retired_park_id` uuid PK, `status` (`taxonomy_review` | `non_park` | `source_withdrawn`), `reason`, `source_code`, `cluster_id`, `release_id`, `created_at`. They get the same deferred checks: no overlap with aliases, not active, not an alias survivor.
Tombstone refs:
- Key `(source_code, external_id)` PK, `retired_park_id` → tombstones, plus `source_url`, `metadata`, `first_seen_at`, `retired_at`.
- A deferred cross-table trigger on **both** `park_source_refs` and this table ensures a source ref is held by one live park **or** one tombstone, never both.

Immutability applies to all three lifecycle tables. UPDATE, DELETE and TRUNCATE raise `55000` unless the transaction sets `set local patika.lifecycle_maintenance='on'`. That escape hatch is only for an explicit correction migration or the importer's alias-flattening step.
`parks` gets a deferred trigger that stops a retired id from ever becoming active again, whether through an upsert with `active=true`, a manual update, or an insert.
All four tables have RLS on and are service-role only. Clients see lifecycle state only through `resolve_park_id`.

## 5. `resolve_park_id(uuid)`
`SECURITY DEFINER`, `STABLE`, callable by `anon` and `authenticated` (the same audience as `get_park`, for deep links). It always returns exactly one row: `(status, resolved_park_id, tombstone_status, reason, release_id)`.

| status | resolved_park_id | when |
|---|---|---|
| `alias` | survivor | id is in aliases (one hop; aliases are flattened) |
| `tombstone` | null | id is in tombstones. `tombstone_status` and `reason` are returned, not hidden as a 404 |
| `live` | input | active park, not retired |
| `inactive` | null | park exists, `active=false`, not retired (moderation hide) |
| `not_found` | null | never issued in this DB (or null input) |

Lifecycle is checked before `parks`, because a retired id may still have an inactive row.

## 6. Per-table policy when an existing park R retires

### Alias (R → survivor S)
| Table | Policy |
|---|---|
| `park_source_refs` | `UPDATE park_id = S` (the PK `(source_code, external_id)` does not change, `first_seen_at` is kept). No ref is copied or dropped |
| `feeding_points` | Points whose `name` does not exist on S are moved (`park_id = S`). A point whose name collides, usually R's general point `id = R`, is kept, set `active=false`, and its dependents are moved to S's point with the same name |
| `feeding_events` | `park_id = S`, and `point_id` is remapped as above. Photos stay readable because `photos_read` checks the event's park, which is now the active S |
| `observations` | `point_id` is remapped to S's point with the same name |
| `favorites` | `(user, R)` becomes `(user, S)`. If `(user, S)` already exists, keep the earlier `created_at` and delete only the now-redundant `(user, R)` row. The user still has the park as a favorite |
| `park_name_suggestions` | **Pending** ones move to S (`original_name` is kept, so `review_park_name` safely refuses to accept one whose name no longer matches). If the user already has a pending suggestion on S, it stays on R and is listed in the apply report. Approved and rejected ones stay on R as history |
| `reports` | Left unchanged. This is moderation history against the id that was reported, and `get_report_context` does not filter on `active`. Open reports on R are listed in the apply report |
| `parks` row R | Stays, with `active=false`. It is never deleted |

### Tombstone (T, no survivor)
- Nothing is repointed and no user content is deleted. T stays in `parks` with `active=false`, and user rows keep a valid FK. The visible effect is the same as a moderation hide: T is removed from maps and feeds, and its photos are visible only to their owner and moderators.
- T's refs **move** from `park_source_refs` to `canonical_park_tombstone_refs`: delete plus insert in the same transaction, checked by the cross-table trigger.
- **Safety gate:** the importer refuses to tombstone a park that has feeding events, favorites, pending suggestions or open reports unless the manifest explicitly lists it with `user_content_ack`. The current RC does not need this, because none of its 66 retired ids exist in any DB.

### Retired ids never materialised in the DB (all 66 in the current RC)
Only the alias or tombstone row is written, plus tombstone refs from the manifest. There are no user rows to move.

## 7. Source-ref migration rules
- **Uniqueness:** `(source_code, external_id)` is unique within `park_source_refs` (PK) and within `canonical_park_tombstone_refs` (PK), and unique across the two tables (deferred trigger).
- **Aliases:** refs move to the survivor with an in-place `UPDATE`. The manifest's `source_refs_preserved` for each alias must equal the set of refs on the survivor that come from the retired id.
- **Tombstones:** refs go into tombstone refs. The RC holds 30 taxonomy-review refs and 3 non-park refs.
- **Review records** (the 383 kept plus the 30 taxonomy-review records) have no DB table yet. See the blockers in §10.
- **Conservation check before COMMIT:** refs before plus refs added must equal refs held by live parks plus refs held by tombstones, and no expected ref may be missing. This is computed per `source_code`.

## 8. Release manifest contract (the input to the importer)
The bundle is one directory with a `manifest.json`. Every file in it is listed with its sha256.
| Artifact | Content |
|---|---|
| `parks.ndjson` | live canonical parks (26,405): id, osm_id, name, city, district, lat/lon, name_status/source/url, source |
| `source_refs.ndjson` | live refs (source_code, external_id, park_id, source_url) |
| `aliases.ndjson` | 33 entries: retired_park_id, canonical_park_id, reason, source_code, cluster_id, source_refs_preserved |
| `tombstones.ndjson` | 33 entries: retired_park_id, status, reason, source_code, cluster_id, source_refs |
| `review_records.ndjson` | 413 records (383 KEEP_REVIEW plus 30 taxonomy-review records) with source ref and reason |
| `non_park_rejections.ndjson` | the 2 REJECT_NON_PARK reviews plus the 3 non-park tombstone refs |
| `manifest.json` | release_id, created_at, git commit, base snapshot file and **base_snapshot_sha256** (`46e485f2…d30a` = nationwide-canonical-preview.json), rc files and hashes, **expected_counts**, **expected_db_state** (§9), verifier output |

`manifest_sha256` is the sha256 of `manifest.json`, which already contains every file hash. The importer must **refuse to run** if any of the following holds:
- a file hash or the manifest hash differs from the frozen values
- a count differs from `expected_counts` (26,405 / 24,750 OSM / 33 / 33 / 413)
- alias or tombstone validation fails (duplicate, self, missing survivor in `parks.ndjson`, chain or cycle, overlap)
- the DB state differs from `expected_db_state`
- a release with the same `release_id` exists with different hashes

If the same `release_id` is already `applied` with identical hashes, the run is a **no-op**.

## 9. Idempotent apply order (one transaction, run as `service_role` / postgres, not supabase-js batches)
0. `BEGIN`, then take `pg_advisory_xact_lock('canonical-release')`. If the release is already applied with the same hashes, `ROLLBACK` as a no-op; if its hashes differ, abort.
1. **Verify the expected base state** (`expected_db_state`):
   - every DB park id that is not in the RC's live set or retired set is listed explicitly with a decision: keep as is, or tombstone. Locally these are 2 smoke-test parks and OSM `way/600671941`.
   - there are no OSM-id or source-ref conflicts
   - no RC live id is currently retired
2. Verify the manifest (hashes, counts, alias and tombstone graph), then insert the `canonical_park_releases` row with status `applying`.
3. Load the ndjson files into temporary staging tables (`COPY`).
4. Upsert live parks. Existing ids update only their data fields; community names stay protected by the existing trigger. Create the general feeding point for new parks.
5. Upsert live source refs (`on conflict (source_code, external_id)`). If a ref already exists on a different park and that park is not being retired into the target, abort.
6. For each alias whose R exists in the DB, migrate the FK rows as in §6. For each tombstone whose T has user content, abort unless `user_content_ack` is set.
7. Move the alias refs (R → S).
8. Insert the alias rows. If an existing alias points at an id that this release retires, re-point it first in maintenance mode.
9. Insert the tombstones, then move the tombstone refs from `park_source_refs` into `canonical_park_tombstone_refs`.
10. Set `active=false` on every retired id that exists in `parks`. Nothing is deleted.
11. Persist the review and non-park records (needs the table from §10).
12. Run the invariant queries: live and OSM counts, per-source ref conservation, no retired id active, no alias chains, every alias survivor active, and resolve spot checks. Then `SET CONSTRAINTS ALL IMMEDIATE` to fire the deferred triggers now.
13. Set the release row to `applied`, then `COMMIT`. Any failure means `ROLLBACK`, which leaves nothing half-applied.

A re-run is safe:
- Step 0 turns a re-run of an applied release into a no-op.
- If a run failed, it rolled back completely, so the next run starts from the same base.
- All upserts are keyed, and lifecycle inserts can only happen once each (PK plus immutability).

## 10. Remaining blockers before an actual RC import
1. **The production DB state is unknown.** It has never been read in this effort. A read-only inventory is needed (park ids and active flags, refs, OSM ids, user-content counts per park) to fill in `expected_db_state`.
2. **DB-only parks** (locally 3, including OSM `way/600671941`, which has user content): each needs a decision. Tombstones currently allow only `taxonomy_review` and `non_park`, so a source-withdrawn OSM park would need either a new status (a migration) or to be kept live.
3. **There is no DB home for the 413 review records and the non-park ledger**, for example a `municipal_review_queue` table. Until one exists they stay in the release bundle and are not in the DB.
4. **The importer does not exist yet.** It must be a single-transaction SQL/`pg` importer. The current importers are non-transactional supabase-js batch upserts and are unsuitable for step 6 onward.
5. **The release bundle has not been built.** It needs to be exported from the frozen `.cache/ordu-consolidation/final/` artifacts into the §8 format, and then its hashes frozen.
6. The migration is tested against the local Docker DB. It is not yet part of the PGlite suite `mobile/tests/database.test.ts`, which lists migrations explicitly; adding it there is a mobile-repo change that was out of scope for this task.
7. `park_summaries`, `get_parks` and the client do not call `resolve_park_id` yet. The deep-link fallback (`get_park` returns nothing, then call `resolve_park_id`, then redirect or show the tombstone state) is a later mobile task.

## 11. Implementation (2026-09-27, second pass): source_withdrawn, reviews and rejections, bundle, importer

### Schema additions (`202609270001`, rewritten in place: it had only been applied to the disposable local DB and was never committed or pushed)
- **`source_withdrawn` tombstone status.** It is generic and never tied to a specific id. It covers a park that is no longer in the canonical source snapshot but must stay resolvable. The `parks` row stays with `active=false`, its refs move to tombstone refs, and user rows are untouched. `resolve_park_id` returns `tombstone` / `source_withdrawn`.
- **`canonical_park_reviews`** (PK `source_code, external_id`). Columns:
  - `release_id`, `review_reason`, `status` (`open`|`resolved`|`dismissed`)
  - `name`, `province`, `district`, `latitude`/`longitude`
  - `candidate_canonical_ids uuid[]`, `related_canonical_id`, `source_url`, `evidence jsonb`, timestamps
- **`canonical_park_rejections`** (PK `source_code, external_id`). Columns: `release_id`, `classification` (`non_park`), `reason`, `taxonomy_class`, `retired_park_id`, `source_url`, `evidence jsonb`.
- **One holder per source ref** (deferred trigger on all four holder tables). A live `park_source_refs` row cannot at the same time be a tombstone ref, an **open** review, or a rejection. A tombstone ref may coexist with a review or rejection: that is the demoted canonical's provenance plus its queue item.
- **Tests:** `supabase/tests/canonical_park_lifecycle.test.sql`, **49/49 PASS**.

### DB-only park policy (generic, decided by evidence, applied by the importer)
A DB park that is not a live park, alias or tombstone of the release is DB-only.

| Class | Evidence rule | Action |
|---|---|---|
| `SOURCE_WITHDRAWN_WITH_HISTORY` / `_NO_HISTORY` | has provenance (`osm_id` and/or refs), every provenance source is in the release `source_scope`, and none of its refs appears anywhere in the release | tombstone `source_withdrawn`; row kept inactive; refs (plus a synthetic `osm:<osm_id>` if needed) go to tombstone refs; user rows untouched |
| `TEST_FIXTURE` | **no** provenance, listed in the target environment's policy file, and every content author has a reserved test-domain account (RFC 2606/6761) | left untouched |
| `UNKNOWN_DB_ONLY` | anything else, including a listed fixture that fails the rules | **the importer aborts** |

Local classification:
- `a0000000-…001` (Smoke Test Parkı) → TEST_FIXTURE (1 event and 1 observation, by `@example.com` smoke accounts)
- `a0000000-…002` (Güllük Parkı) → TEST_FIXTURE (no content)
- `d6f93406-…` (OSM `way/600671941`) → SOURCE_WITHDRAWN_NO_HISTORY

The environment policy is `data/canonical-releases/environments/local.json`. Production needs its own file built from a read-only inventory.

### Frozen bundle
- **Config:** `data/canonical-releases/patika-parks-2026-09-27-rc1.json` holds the frozen source hashes, expected counts and the pinned `expected_manifest_sha256`.
- **Exporter:** `scripts/export-canonical-release-bundle.mjs`. It hash-checks every frozen input, recomputes nothing, and its output is byte-reproducible (verified by a second export).
- **Validator:** `scripts/canonical-release-bundle.mjs#validateBundle`, a hard failure on any mismatch.
- **Bundle:** `.cache/releases/patika-parks-2026-09-27-rc1/`, manifest sha256 `b03bea54af0b8bdfbbdce5208407fffc4bd441a273c532379ac68ff86f3ac88a`. Contents:

| File | Records |
|---|---|
| `parks.json` | 26,405 (24,750 OSM) |
| `park_source_refs.json` | 27,944 |
| `aliases.json` | 33 |
| `tombstones.json` | 33 (30 taxonomy_review + 3 non_park; 33 refs) |
| `reviews.json` | 413 (383 KEEP_REVIEW + 30 taxonomy) |
| `rejections.json` | 5 (2 REJECT_NON_PARK + 3 non-park) |

### Importer: `scripts/apply-canonical-release.mjs` + `scripts/sql/apply-canonical-release.sql`
One psql session, `BEGIN` … `COMMIT`, under an advisory lock. It refuses any non-local target unless `--allow-remote` is given. The steps:
1. Validate the bundle.
2. Run a read-only pre-check. An already-applied release with identical hashes is a **no-op**; different hashes mean refuse.
3. Check prerequisites (migration, tables, function) and refuse if a release row already exists.
4. Load the bundle into staging with `COPY` and check the staging counts and graph.
5. Check the expected DB state:
   - no live id is already retired
   - no OSM identity conflicts
   - a DB ref may move only through an alias of the release
   - review/rejection refs are not live, except on a park tombstoned with that same ref
   - DB-only classification, aborting on unknowns
   - tombstoning a park with history requires an acknowledgement
6. Insert new parks and update existing ones. Only data fields change: `active` is never touched, community names stay protected, and `address_label` only fills blanks. Create general feeding points where missing.
7. For each alias whose retired park exists:
   - a same-named point (the general one) is **merged**: its events and observations move to the survivor's point, and the old point stays inactive
   - a custom point is **re-parented**
   - events move
   - favorites move and are deduplicated (earliest `created_at` kept)
   - pending suggestions move unless the user already has one pending on the survivor
   - reports stay on the retired id
   - refs move
   - the retired row is deactivated
8. Insert alias rows, tombstone rows and tombstone refs, and create `source_withdrawn` tombstones.
9. Upsert live refs. Only changed rows are updated.
10. Upsert reviews and rejections.
11. Check final invariants: counts, attachments, no retired id active, one-hop live survivors, no lost ref, user-content counts preserved (favorites minus deduplicated only), event/point consistency. Then `SET CONSTRAINTS ALL IMMEDIATE`.
12. Mark the release `applied`, then `COMMIT`.

### Local test: `scripts/test-apply-canonical-release-local.mjs` → 35/35 PASS
The runner uses the local Docker DB only and restores the pre-test baseline byte-identically at the end.
- **Plain local baseline** (dry run): 1,981 parks → 26,408 parks.
  - 26,407 active: 26,405 release plus 2 fixtures
  - 1 inactive: source_withdrawn
  - 33 aliases; 34 tombstones (30 taxonomy_review, 3 non_park, 1 source_withdrawn); 34 tombstone refs
  - 413 reviews, 5 rejections, 27,944 refs
  - 24,427 inserted, 1,860 updated
- **Simulated legacy base:** 6 of the release's own retired and survivor parks, seeded with events, a custom point, observations, favorites, suggestions and reports. Every content move and deduplication was verified.
- **Negative tests, each leaving the DB byte-identical:** corrupted artifact; modified manifest; injected failure after all writes; tombstone with history and no acknowledgement; unknown DB-only park.
- **Re-apply** is a NO-OP (identical fingerprint). A forced re-apply hits the in-transaction guard and rolls back.

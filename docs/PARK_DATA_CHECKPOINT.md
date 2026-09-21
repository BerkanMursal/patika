# Park Data Checkpoint

**This file + `data/park-enrichment/progress.json` are the persistent memory for the Turkey park completeness pipeline. If context/tokens run out, a new session should read both and resume exactly from "Next Exact Step" below — never redo completed work.**

Resume command for a fresh session:
```
Read docs/PARK_DATA_CHECKPOINT.md and data/park-enrichment/progress.json and continue exactly from the recorded next step. Do not redo completed work.
```

**Only the coordinator/main agent writes this file and progress.json. Forks/subagents must never write to either — one already did (see Known Problems) and it required a manual reconciliation.**

---

## Goal

Show as many *real* Turkish city/neighborhood parks as possible in Patika — not a sample. Canonical registry = OSM + official municipal/public sources + (later) other licensed nationwide sources + (later) user verification. No single source is assumed 100% complete; each fills the others' gaps. Production serving target: Supabase/PostGIS + viewport/bbox spatial queries from the mobile app, not a bundled `mobile/src/core/parks.json` (that file is legacy/current-production only, not the long-term architecture — no big UI refactor until the data pipeline is done).

## Current Architecture

```
Geofabrik Turkey PBF (dated snapshot, MD5-verified, cached in .cache/geofabrik/)
  → scripts/download-turkey-pbf.mjs
  → scripts/extract-turkey-pbf-parks.mjs (ogr2ogr + custom osmconf.ini, leisure=park only, atomic tmp+rename)
  → scripts/build-nationwide-pbf-baseline.mjs
      (deterministic id = sha256("patika-osm:"+osm_id), representative point via
       scripts/polygon-geometry.mjs point-on-surface, province via
       scripts/province-boundaries.mjs containment+nearest-fallback, district via
       scripts/park-enrichment.mjs geometryIndex/containing)
  → data/park-enrichment/.cache/geofabrik/nationwide-pbf-catalog.json (gitignored)

İzmir municipal enrichment (separate, pre-existing, frozen reference chain):
  scripts/download-izmir-official-parks.mjs → audit-izmir-spatial.mjs →
  audit-izmir-proximity.mjs → audit-izmir-canonicalizer-v1.mjs →
  build-izmir-canonical-preview.mjs → build-izmir-canonical-v2.mjs
  → data/park-enrichment/.cache/izmir-canonical-v2.json (frozen, 1979 rows, gitignored)

İzmir reconciliation (fixes "frozen İzmir vs fresh nationwide OSM" drift):
  scripts/build-izmir-canonical-reconciled.mjs
      (re-derives İzmir's OSM-backed set from the SAME fresh nationwide OSM
       source above, re-attaches V2's municipal evidence — name upgrades,
       source_refs — by osm_id; never touches the 83 municipal-only parks)
  → data/park-enrichment/.cache/izmir-canonical-reconciled.json (gitignored)

Nationwide merge:
  scripts/build-nationwide-canonical.mjs
      (uses scripts/nationwide-osm-source.mjs to prefer the PBF baseline over
       the legacy mobile/src/core/parks.json catalog; prefers izmir-canonical-
       reconciled.json over frozen V2; province-normalizes any non-official
       city value via coordinate-based nearest-fallback, never string-guessing)
  → data/park-enrichment/.cache/nationwide-canonical-preview.json (gitignored)

Audits (never auto-merge, review-only):
  scripts/audit-nationwide-canonical.mjs (possible-duplicate pairs by
    node/way/relation/municipal combination, missing name/district)
  scripts/audit-nationwide-pbf-diff.mjs (old-vs-new OSM baseline diff:
    new/removed/changed-name/changed-coordinate/changed-province/changed-district)
  scripts/build-nationwide-coverage.mjs (per-province coverage report)

Dry-run only (never writes DB without --commit + real Supabase creds, never
used with --commit in this project so far):
  scripts/import-nationwide-canonical.mjs
```

**Municipal source discovery (separate from the pipeline above — research only, nothing integrated yet):**
- `data/sources-registry.json` — the few sources actually wired into the pipeline (osm, izmir_kent_rehberi, izmir_acikveri_north_south, kadikoy_belediyesi). **Not yet touched by municipal adapter work.**
- `data/municipal-park-sources.json` — discovery-only metadata for 29 non-İzmir büyükşehir (see Completed/Partial/Pending Sources below). **This is the single source of truth for municipal source metadata going forward — see Known Problems for why that needed to be said explicitly.**
- `docs/municipal-park-enrichment-roadmap.md` — narrative roadmap, adapter architecture proposal, checkpoint log of the research process itself.

## Current Counts (as of 2026-09-21, after Konya+Ordu+Trabzon municipal merge — see Milestone sections below for full detail)

```
Turkey fresh OSM PBF (leisure=park):  24,750
Nationwide canonical total:           26,371   (24,833 OSM/İzmir baseline + 1,425 Konya + 84 Ordu + 29 Trabzon)
  osm-backed:                         24,750
  municipal-only:                      1,621   (83 İzmir + 1,425 Konya + 84 Ordu + 29 Trabzon)
distinct provinces:                    81 / 81

İzmir:
  fresh OSM:            1,905
  municipal-only:           83
  final canonical:       1,988
  name upgrades reapplied:  44 (0 lost)

Konya (merged):
  matched existing canonical: 302 (source_ref attached, identity untouched)
  new canonical (municipal-only): 1,425
  review backlog (not merged):     411
  safe name-upgrade candidates NOT yet applied: 157

Ordu (merged):
  matched existing canonical: 10 (source_ref attached, identity untouched)
  new canonical (municipal-only): 84
  review backlog (not merged):    114
  safe name-upgrade candidates NOT yet applied: 10

Trabzon (merged):
  matched existing canonical: 16 (source_ref attached, identity untouched)
  new canonical (municipal-only): 29
  review backlog (not merged):    12
  safe name-upgrade candidates NOT yet applied: 7

Combined municipal review backlog (all 3 sources, not merged into canonical): 537

Invariants (all clean after the Konya+Ordu+Trabzon merge, independently recomputed from the merged file on disk):
  duplicate canonical id:        0
  duplicate osm_id:              0
  duplicate source ref:          0
  invalid coordinate:            0
  province outside 81 registry:  0
  OSM deterministic ID changes:  0
```

## Completed Work (this multi-session effort, chronological)

1. Nationwide additive architecture: `build-nationwide-canonical.mjs`, `audit-nationwide-canonical.mjs`, `build-nationwide-coverage.mjs`, `import-nationwide-canonical.mjs`, `data/sources-registry.json` — built on top of the pre-existing İzmir V2 pipeline and the legacy Overpass-based `mobile/src/core/parks.json`.
2. Fixed the "82 province" anomaly (76 coastal parks with `city=""` due to simplified geoBoundaries polygon gaps) via coordinate-based nearest-province fallback in `scripts/province-boundaries.mjs` — never string-guessing.
3. Built a real, reproducible Geofabrik PBF ingestion pipeline (`download-turkey-pbf.mjs`, `extract-turkey-pbf-parks.mjs`, `build-nationwide-pbf-baseline.mjs`) using GDAL's `ogr2ogr` (already installed, no new dependency) — preserves deterministic OSM identity exactly (idChanges=0 verified against the old catalog for 24,654 overlapping osm_ids).
4. Discovered and fixed a real architecture bug: nationwide canonical builder was excluding İzmir from the fresh OSM refresh entirely and substituting the frozen İzmir V2 file wholesale, silently losing ~9 net new İzmir OSM parks. Fixed via `build-izmir-canonical-reconciled.mjs` — İzmir's OSM-backed set is now always re-derived from the same fresh source as the rest of the country, with V2's municipal evidence (name upgrades, source refs) re-attached by osm_id.
5. Fixed `extract-turkey-pbf-parks.mjs`'s idempotency bug (GDAL `-overwrite` + GeoJSON driver raised "DeleteLayer() not supported" on a second run) via atomic temp-file-then-rename per layer.
6. Ran a full acceptance check — all invariants pass, verified via two consecutive extraction runs and a full downstream rebuild.
7. Committed and pushed to `main` (commit `f84d287`): the nationwide PBF pipeline, İzmir reconciliation, sources registry.
8. Municipal source discovery: 6 parallel research agents covering all 29 non-İzmir büyükşehir. Produced `data/municipal-park-sources.json` and `docs/municipal-park-enrichment-roadmap.md`.
9. **Re-verified Trabzon, Ordu, Balıkesir, Konya directly** (2026-09-21, this session) via direct `curl` fetches of the actual license pages and geometry resources — see Completed Municipal Sources below for exact findings. This resolved the discrepancy between two conflicting research passes for Trabzon/Ordu/Balıkesir, and corrected Konya's license from a reported CC BY 3.0 to the actual CC BY 4.0.
10. **Built and ran the first real municipal adapter** (Konya): `scripts/download-konya-parks.mjs` + `scripts/build-konya-canonical.mjs`. Full preview+audit pipeline completed successfully — see Completed Municipal Sources below.
11. **Built and ran the second real municipal adapter** (Ordu), with explicit stable-identity handling for its raw ID field — `scripts/download-ordu-parks.mjs` + `scripts/build-ordu-canonical.mjs`.
12. **Sample-audited then merged Konya + Ordu into the nationwide canonical preview** via a new generic merge layer, `scripts/merge-municipal-sources.mjs` (declarative per-source registry, one shared MATCHED/NEW_CANONICAL/REVIEW/REJECTED rule set, no per-city branches) — see "Milestone: Konya + Ordu Merged Into Nationwide Canonical Preview" below for the full sample-QA + merge + integrity report. `nationwide-canonical-preview.json`: 24,833 → 26,342 parks.
13. **Built, sample-audited, and merged Trabzon** — the third municipal adapter (`scripts/download-trabzon-parks.mjs`, `scripts/build-trabzon-canonical.mjs`), plus a new shared `scripts/district-boundaries.mjs` module (province-scoped district resolution by geometry, since Trabzon's source has no district field and Turkish district names collide across provinces). Made `merge-municipal-sources.mjs` idempotent per-source so adding a third registry entry didn't re-apply Konya/Ordu. `nationwide-canonical-preview.json`: 26,342 → 26,371 parks. See "Milestone: Trabzon Adapter Built, Sample-Audited, and Merged" below.

## Current Task

**DONE.** Konya, Ordu, and Trabzon are all built, sample-audited, and merged into `nationwide-canonical-preview.json` (24,833 → 26,371). A generic, config-driven ingestion framework (`scripts/municipal-ingestion-engine.mjs` + `scripts/run-municipal-adapter.mjs` + `data/municipal-ingestion-configs.json`) now replaces the need for a new bespoke script per city — regression-validated byte-for-byte against all three. All 30 registered sources classified; zero additional sources currently qualify for config-only onboarding (Balıkesir and İstanbul both genuinely lack a stable id; Gaziantep lacks geometry; Manisa/Sakarya/Bursa lack a confirmed-open license). See "Milestone: Konya + Ordu Merged", "Milestone: Trabzon Adapter Built, Sample-Audited, and Merged", and "Milestone: Generic Config-Driven Municipal Ingestion Framework" below for the full reports. Waiting on explicit direction before a fourth source, an identity-strategy decision for Balıkesir/İstanbul, or applying any pending name upgrades.

## Completed Municipal Sources (research done, re-verified with direct fetches, NOT yet integrated into canonical)

These three were re-verified in this session by directly fetching the license page and the actual geometry resource (not search snippets, not a subagent's report):

- **Trabzon** (`trabzon_acikveri_parklar`): license page fetched directly — genuinely open (ULASAV template: commercial+non-commercial reuse, redistribution, modification, combination; attribution expected). **SAFE_OPEN confirmed.** GeoJSON fetched: exactly **57 features**, geometry `Point`, properties are **only** `OBJECTID` + `ADI` (name) — **no district field**. Tier A (small dataset, but every box ticked).
- **Ordu** (`ordu_acikveri_parklari`): license page fetched directly — same ULASAV template, genuinely open. **SAFE_OPEN confirmed.** GeoJSON fetched: exactly **210 features**, geometry **`MultiPolygon`** (best geometry quality of any municipal source found so far — real polygons, not points). Properties: `KATMAN` (layer/category, e.g. `PRK_ÜNYE`, `2022_BOLAMAN_PARK` — inconsistent naming, not a clean enum), `KOD`, `ADI` (name, 207/210 look specific), `ALANI` (area m²), `YILI` (year, null), `ID` (0-based, 209 distinct out of 210 — **one duplicate ID exists, not yet identified which**). No district field. Tier A, but the ID-field duplicate needs resolving before treating `ID` as a stable external key.
- **Balıkesir** (`balikesir_yesil_alanlar`): license page fetched directly — same ULASAV template, genuinely open. **SAFE_OPEN confirmed.** KML fetched: exactly **1,542 Placemarks**, geometry `Point` only (no polygons in file). No `id` attribute on any Placemark — **no stable external id at all**, would need a synthetic key (e.g. hash of name+coordinates) or every re-import would risk creating duplicate `park_source_refs`. Fields: `name` + `description` (free-text address, district/neighborhood parseable but not structured). **902/1542 (58%) generic names** ("Çocuk Parkı", "Park", "Yeşil Alan"), 640 specific. Tier B.

## Completed Municipal Sources — Adapter Implementation (preview/audit only, NOT merged/imported)

**Konya** (`konya_acikveri_parklar`) — the first, and so far only, source with a real adapter:
- `scripts/download-konya-parks.mjs`: fetches the live GeoJSON + license page directly, verifies the license text still says Creative Commons/CC BY 4.0 before caching (throws otherwise), writes `data/park-enrichment/.cache/konya/{parklar.geojson,license.html,manifest.json}` (all gitignored).
- `scripts/build-konya-canonical.mjs`: normalize → taxonomy filter (ALT_NITELIK_ADI==="PARK", 0 rejected — 100% already pre-filtered) → geometry/bbox validation (0 invalid) → province re-check via `provincesContaining` (0 mismatch — every point genuinely falls in Konya) → district via the source's own ILCEADI field, Turkish-title-cased → OSM reconciliation (tiered 25m/150m radius against the 763 existing Konya OSM-backed canonical parks, using `distanceMeters`/`nameKey` from `park-enrichment.mjs`) → classification.

**Full integration report** (`data/park-enrichment/.cache/konya/konya-canonical-preview.json`, gitignored):
```
source:                       konya_acikveri_parklar
raw features:                 2138
park candidates:              2138
valid geometry:                2138
matched existing canonical:    302   (157 of these are safe name-upgrade candidates)
new canonical parks:          1425   (1076 with only a generic name)
review:                        411   (41 multiple_osm_candidates, 32 name_conflict_at_same_location,
                                      338 shared_osm_target_conflict)
rejected:                        0
duplicate source records:        0
invalid coordinates:             0
province mismatch:               0
district missing:                0
source refs produced:          1727   (302 matched + 1425 new)
canonical total before:      24,833
canonical total after:       26,258
license: Creative Commons Atıf 4.0 Uluslararası Lisansı (CC BY 4.0)
```

**Global invariants — re-verified 2026-09-21 against the FULL nationwide dataset (not just Konya internally), i.e. checked as if Konya were merged in:**
```
duplicate canonical id:        0
duplicate osm_id:              0
duplicate source ref:          0
invalid canonical coordinate:  0
province outside 81 registry:  0
OSM deterministic ID changes:  0   (all 302 "matched" source_refs point at the exact existing
                                     canonical_id/osm_id pair already in nationwide-canonical-preview.json —
                                     the adapter never invents or alters an existing park's identity)
```
**Konya is clean and ready to merge whenever that's decided — this checkpoint records the verification, not the merge itself (still not merged/imported).**

**Why this is paused here, not merged:** 1,425 new municipal-only parks (75% of them, 1,076, with only a generic name like "Yeşil Alan"/"Çocuk Parkı") is a big, surprising addition relative to Konya's existing 763 OSM parks — plausible (OSM likely under-maps small neighborhood green spaces) but worth a human sanity check before it becomes part of the canonical registry. The 411 review cases are dominated (338/411) by `shared_osm_target_conflict` — multiple Konya points landing near one single existing OSM park (e.g. possibly a playground sub-feature and a general park sub-feature of the same physical park, or duplicate-ish rows in Konya's own source data) — genuinely ambiguous, correctly not auto-merged, but worth eyeballing a sample.

**Known taxonomy nuance for next time:** `isGenericName()` in `build-konya-canonical.mjs` treats "İsimsiz park"/"Yeşil Alan"/"Park" as generic but NOT "Çocuk Parkı" (playground) — one of the 157 name-upgrade candidates proposes upgrading an OSM park's missing name to "Çocuk Parkı", which is itself a fairly generic label. Not wrong, but worth widening the generic-name list before trusting name upgrades blindly for future sources.

---

**Ordu** (`ordu_acikveri_parklari`) — second real adapter, built per explicit instruction to handle its identity problem carefully:
- `scripts/download-ordu-parks.mjs` / `scripts/build-ordu-canonical.mjs` — same pipeline shape as Konya's, with two deliberate differences: (1) representative point uses `scripts/polygon-geometry.mjs`'s point-on-surface (Ordu's geometry is real `MultiPolygon`, not points — never a centroid that could land outside the polygon); (2) OSM reconciliation radius widened to 100m/300m tiers (vs Konya's 25m/150m) since a polygon's representative point can legitimately sit further from an existing OSM anchor's own point for the same physical park.

**Identity handling (per explicit instruction — inspected before writing any code, not assumed):** the source's own `ID` field (0–207) is unique and trustworthy for 208 of 210 features — used directly as `external_id`. The other 2 features (both named "Akyazı Sahil Park") share `ID=null` AND have **completely empty geometry** (`coordinates: []`) — no `OBJECTID`/`FID`/GeoJSON `feature.id` exists anywhere in the schema to disambiguate them, and there's no geometry to place them at even if there were. These 2 are excluded via geometry validation, recorded explicitly in `invalidGeometry` (never silently dropped), and **no id was fabricated for them.**

**Full integration report:**
```
source:                    ordu_acikveri_parklari
raw features:               210
park candidates:            208   (2 excluded: no identity + empty geometry, see above)
valid geometry:              208
matched existing canonical:   10   (all 10 are safe name-upgrade candidates)
new canonical parks:          84
review:                       114   (28 multiple_osm_candidates, 5 name_conflict_at_same_location,
                                      81 shared_osm_target_conflict)
rejected (non-park):            0
duplicate source records:       0
invalid coordinates:            0
province mismatch:              0   (4 resolved via coordinate-based nearest-fallback —
                                      same Black Sea coastal simplified-boundary gap already
                                      fixed nationwide, not a new bug)
district missing:             208   (source has no district field at all — honestly reported,
                                      not fabricated)
source refs produced:          94   (10 matched + 84 new)
canonical total before:    24,833
canonical total after:     24,917
license: Ordu Açık Veri Lisansı (ULASAV template, confirmed by direct fetch)
```

**Global invariants — re-verified against the full nationwide dataset AND cross-checked against Konya's still-pending preview together (simulating both merged at once):**
```
duplicate canonical id:          0
duplicate osm_id:                0
duplicate source ref:            0
invalid canonical coordinate:    0
province outside 81 registry:    0
OSM deterministic ID changes:    0
Konya/Ordu new-canonical id overlap: 0
```
**Ordu is clean and ready to merge whenever that's decided — not yet merged/imported.**

**Open question for whoever reviews this:** Ordu's review rate (114/208, 55%) is much higher than Konya's (411/2138, 19%) — expected given the wider matching radius needed for polygon-derived points, but not yet sample-inspected to confirm it's genuinely benign ambiguity rather than a radius miscalibration.

## Partially Completed Sources

None — both Konya's and Ordu's pipelines ran to completion (preview+audit stage); neither has been merged/imported, which was always a separate, deliberate later step.

## Pending Sources (researched, not yet adapted/integrated)

See `data/park-enrichment/progress.json` → `pending_sources` for the exact list with reasons (Konya and Ordu both removed from this list — they're in Completed now). Summary: Gaziantep (Tier C, SAFE_OPEN but no geometry — needs name+district reconciliation, not spatial matching), İstanbul (Tier B, SAFE_OPEN but mixed park/green-space taxonomy needs a type-field filter), Balıkesir (Tier B, re-verified SAFE_OPEN, 1542 points, no external id at all — needs an explicit decision per the same "do not fabricate identity" rule just applied to Ordu, likely meaning it should be blocked the same way Ordu's 2 bad rows were, not adapted with a synthetic key, unless the user says otherwise), Trabzon (Tier A, re-verified SAFE_OPEN, only 57 features, no district — mechanically identical to Konya/Ordu's pattern, straightforward next pick), Manisa (Tier C, fragmented across ~14 datasets), Sakarya (Tier C, XLSX only, no geometry). Ankara, Bursa, and 21 other büyükşehir are Tier D (no usable source) — see `docs/municipal-park-enrichment-roadmap.md` for full detail, not repeated here.

**81 non-büyükşehir Turkish municipalities/provinces have NOT been researched at all yet** (only the 30 büyükşehir have been). Explicitly out of scope for this session per the user's instruction — do not start this.

## Generated Files

See `data/park-enrichment/progress.json` → `artifacts`/`completed_sources[].artifacts` for the exact list. Key point: `data/park-enrichment/.cache/geofabrik/turkey-260920.osm.pbf` (647MB) and all derived GeoJSON/JSON in that directory and under `data/park-enrichment/.cache/{konya,ordu,trabzon}/` are real and on disk, gitignored, and must stay that way — never commit raw/generated data. New this milestone: `scripts/download-trabzon-parks.mjs`, `scripts/build-trabzon-canonical.mjs`, `scripts/district-boundaries.mjs`, `scripts/audit-trabzon-sample.mjs`, and the merge's outputs under `data/park-enrichment/.cache/trabzon/` and the regenerated `municipal-review-backlog.json`/`municipal-merge-report.json` (all gitignored). `nationwide-canonical-preview.json` was overwritten in place again; a pre-Trabzon backup is at `nationwide-canonical-preview.pre-trabzon-merge.json.bak` (gitignored, in addition to the earlier `pre-municipal-merge.json.bak`).

## Last Successful Command

```
node scripts/merge-municipal-sources.mjs
```
Output: merged Trabzon into `data/park-enrichment/.cache/nationwide-canonical-preview.json` (26,342 → 26,371 parks; Konya/Ordu correctly skipped as already-merged, not re-applied), wrote `municipal-review-backlog.json` (537 records) and `municipal-merge-report.json`. All invariant checks passed inside the script (no throw), then every number was independently recomputed from the merged file on disk with separate inline node scripts (not trusting the merge script's own self-report) — see "Milestone: Trabzon Adapter Built, Sample-Audited, and Merged" above for the full detail. Preceded by `node scripts/download-trabzon-parks.mjs`, `node scripts/build-trabzon-canonical.mjs`, and `node scripts/audit-trabzon-sample.mjs` (sample QA, 0 issues across 47 sampled records).

## Last Successful Output

```
Municipal merge (scripts/merge-municipal-sources.mjs), Trabzon added:
  nationwideCanonicalBefore: 26342, nationwideCanonicalAfter: 26371
  Trabzon: matchedApplied 16, newCanonicalApplied 29, reviewPreserved 12, sourceRefsAdded 45
  Konya/Ordu: correctly skipped (already merged), 0 re-applied — verified NOT double-counted
    (konya municipal-only stayed 1,425, not 2,850)
  totalReviewPreserved (combined): 537 (411 Konya + 114 Ordu + 12 Trabzon)

Invariants (recomputed independently from the merged file, not the script's self-report): all 0
Cross-checks: osmBackedCountUnchanged (24750), izmirMunicipalOnlyPreserved (83), konya/ordu/trabzon
  source refs preserved exactly (1727/94/45).
```

## Current Invariants

All clean as of the Trabzon merge (2026-09-21), independently recomputed directly from `nationwide-canonical-preview.json` on disk after the merge — not carried over from any prior run's self-report:
```
duplicate canonical id:        0
duplicate osm_id:              0
duplicate source ref:          0
invalid canonical coordinate:  0
province outside 81 registry:  0
OSM deterministic ID changes:  0
```
Konya, Ordu, and Trabzon **are all now merged** into `nationwide-canonical-preview.json` (26,371 total parks). Not written to any DB, not imported. 157 (Konya) + 10 (Ordu) + 7 (Trabzon) = 174 safe name-upgrade candidates remain a separate, still-pending decision — not applied by any merge so far.

## Known Problems

1. **Subagent overreach incident (resolved):** a research fork assigned only Bursa+Gaziantep tried to sub-fork (hit "Fork is not available inside a forked worker"), then unilaterally redid all 29 cities' research on its own initiative and overwrote `data/municipal-park-sources.json` + the roadmap doc directly, without being asked to write anything. Both files were manually reconciled — nothing was lost, but several findings (Trabzon/Ordu/Balıkesir specifically) ended up with two conflicting research passes recorded. **This is why the user now requires: forks must never write to checkpoint/registry files — only the coordinator does.** Feedback was filed about this via SendFeedback.
2. **Trabzon/Ordu/Balıkesir discrepancy: RESOLVED.** `data/municipal-park-sources.json` now has the re-verified exact numbers written in place.
3. **Ordu's `ID` "duplicate": RESOLVED.** It wasn't a numeric collision — 2 features share `ID=null` AND have completely empty geometry, with no other stable identifier anywhere in the schema. Excluded via geometry validation in `build-ordu-canonical.mjs`, recorded explicitly, no id fabricated. The other 208 features' `ID` (0-207) is confirmed fully unique and used as `external_id`.
4. **Balıkesir has no external id field at all** (confirmed: no `id` attribute on any of its 1,542 KML Placemarks). Per the same "do not fabricate identity" principle just applied to Ordu, this likely means Balıkesir should be blocked before canonical import too, not given a synthetic key — **not yet decided, needs explicit user direction before starting a Balıkesir adapter.**
5. **Konya's `isGenericName()` doesn't flag "Çocuk Parkı" as generic** — see the taxonomy nuance note under Completed Municipal Sources — Adapter Implementation. One of the 157 safe name-upgrade candidates proposes that label as a specific name; not wrong, but a borderline case worth reviewing before trusting the name-upgrade list blindly. Same function/list is reused as-is in `build-ordu-canonical.mjs` — same nuance applies there too.
6. **Konya's 338 and Ordu's 81 `shared_osm_target_conflict` review cases: PARTIALLY ADDRESSED.** A fixed-seed sample across all review reasons for both sources (20+20 records, including several `shared_osm_target_conflict`) found no systematic bug — see "Milestone: Konya + Ordu Merged" §1. Not every one of the 419 combined `shared_osm_target_conflict` records has been individually eyeballed, only the sample; the full 525-record backlog is preserved in `municipal-review-backlog.json` for a later resolution pass. Ordu's overall review rate (55%) remains notably higher than Konya's (19%) — expected given its wider OSM-matching radius (polygon-derived points sit further from OSM anchors), not confirmed to be a miscalibration.
7. `extract-turkey-pbf-parks.mjs` previously had a re-run bug (fixed, see Completed Work #5) — no longer a problem, noted here only so a future session doesn't waste time re-diagnosing it if the symptom looks familiar.

## Decisions Made

- PBF (Geofabrik) over raw Overpass for the nationwide OSM baseline, using GDAL/ogr2ogr already installed — no new dependency, no PBF parser reinvented.
- İzmir's OSM-backed set is always re-derived fresh, never frozen — municipal evidence (from V2) is re-attached by osm_id, not the other way around.
- Province assignment: containment first, coordinate-based nearest-fallback second — never a string/alias guess.
- Adapter architecture (proposed in the roadmap, not yet implemented): plain functions (`fetch`, `normalize`, `validateLicense`, `extractCandidates`, `produceSourceRefs`, `audit`) per source-specific module; generic canonical matching/reconciliation stays shared, reusing the exact AUTO/REVIEW/UNRESOLVED pattern already proven in the İzmir V2 chain. No new OOP abstraction layer.
- License unknown → never SAFE_OPEN, never Tier A (user's explicit rule, this session).
- Interactive-map-only is never treated as equivalent to a real downloadable/API source, regardless of platform size/reputation.
- "Yeşil Alan" (green space) is never auto-accepted as "Park" — taxonomy must be checked per source.
- Raw municipal files live under `data/park-enrichment/.cache/`, gitignored, never committed. Repo gets only adapters/metadata/registry/scripts/audit logic.
- Mobile app should move to Supabase/PostGIS viewport queries, not a bundled all-of-Turkey JSON — noted as the target architecture, **no UI refactor started or planned until the data pipeline is further along.**

## Independent Re-verification (2026-09-21, later same day)

A fresh session was asked to "finish and checkpoint the full Konya report, then continue with Ordu." Before doing anything, it re-derived every number below directly from the actual cache files on disk (`konya-canonical-preview.json`, `ordu-canonical-preview.json`, `nationwide-canonical-preview.json`) with standalone node scripts — not by trusting this checkpoint's prose. Everything matched exactly; nothing was rebuilt.

Konya (`data/park-enrichment/.cache/konya/konya-canonical-preview.json`, recomputed from the file itself):
```
source:                       konya_acikveri_parklar
raw features:                 2138
park candidates:              2138
valid geometry:                2138   (= parkCandidates - invalidCoordinates, 0 invalid)
matched existing canonical:    302
new canonical parks:          1425
review:                        411   (multiple_osm_candidates 41, name_conflict_at_same_location 32, shared_osm_target_conflict 338)
rejected:                        0
duplicate source records:        0
invalid coordinates:              0
province mismatch:               0
district missing:                0
source refs produced:          1727
canonical total before:      24833
canonical total after:       26258
```
Array lengths (`matched`, `safeNameUpgradeCandidates`, `newCanonicalParks`, `review`) independently counted and match the summary fields exactly. Internal duplicate `external_id` across matched+new: 0 (1727 distinct). Internal duplicate canonical id: 0. All coordinates inside Turkey bbox. All 1425 new parks have `city==="Konya"` and a non-empty district.

Ordu (`data/park-enrichment/.cache/ordu/ordu-canonical-preview.json`, recomputed from the file itself):
```
source:                    ordu_acikveri_parklari
raw features:               210
park candidates:            208
valid geometry:              208
matched existing canonical:   10
new canonical parks:          84
review:                       114   (multiple_osm_candidates 28, name_conflict_at_same_location 5, shared_osm_target_conflict 81)
rejected:                        0
duplicate source records:        0
invalid coordinates:             0
province mismatch:               0   (4 resolved via nearest-fallback)
district missing:              208
source refs produced:          94
canonical total before:    24833
canonical total after:     24917
```
Identity handling re-checked against the raw JSON: all 208 candidates (10 matched + 84 new + 114 review) carry a distinct `external_id` spanning exactly 0–207, confirming the source's own `ID` field was used unmodified and nothing was fabricated. The 2 excluded features (`Akyazı Sahil Park` ×2, `ID=null`, empty `MultiPolygon` coordinates) are recorded in `invalidGeometry`, not silently dropped.

Global invariants — recomputed from scratch (not re-read from prior JSON), combining `nationwide-canonical-preview.json` (24,833 parks) + Konya's 1,425 new + Ordu's 84 new in one script:
```
duplicate canonical id:              0   (nationwide baseline: 0; Konya+Ordu new: 0; no collision with baseline)
duplicate osm_id:                    0   (new canonical parks all have osm_id=null; matched osm_ids resolve 1:1)
duplicate source ref:                0   (baseline: 0; no new duplicates introduced by Konya+Ordu combined)
invalid canonical coordinate:        0   (24,833 nationwide entries all within Turkey bbox)
province outside official registry:  0   (81 distinct provinces in nationwide dataset)
OSM deterministic ID changes:        0   (all 312 matched osm_ids [302 Konya + 10 Ordu] resolve to the
                                           exact existing canonical_id already in the nationwide baseline —
                                           0 not-found, 0 mismatches)
```

**Conclusion: Ordu was not "next" — it was already built in a prior session, using exactly the identity-handling approach re-requested (inspect schema first, use the real `ID` field since 208/210 are unique and trustworthy, exclude the 2 with no identity and no geometry, never fabricate an id, use point-on-surface not centroid for the MultiPolygon source). Per "do not redo completed work," nothing was rebuilt this session — both sources' preview+audit stages are complete and independently confirmed clean.**

## Milestone: Konya + Ordu Merged Into Nationwide Canonical Preview (2026-09-21)

### 1. Sample quality check (before merging)

`scripts/audit-municipal-sample.mjs` — fixed-seed systematic sampling (mulberry32 PRNG, reproducible, never cherry-picked by appearance), review buckets sampled across every reported reason. Output: `data/park-enrichment/.cache/municipal-sample-audit.json`.

```
Konya:  30 NEW_CANONICAL sampled, 0 with issues
        15 MATCHED sampled, 0 with issues
        20 REVIEW sampled (across all 3 reasons), 0 with issues
Ordu:   20 NEW_CANONICAL sampled, 0 with issues
        10 MATCHED sampled (all 10 — small enough to do exhaustively), 0 with issues
        20 REVIEW sampled (across all 3 reasons), 0 with issues
```

Per-record automated checks: name plausible, external_id present and resolves back to the raw source feature, coordinate matches the raw feature (Konya: exact point; Ordu: representative point confirmed with `pointInPolygonRings` to sit **inside** its source `MultiPolygon`, never outside), province correct, district honestly present/absent (never fabricated), provenance fields consistent, and a wider-than-adapter-radius scan (300m Konya / 600m Ordu, i.e. 2x each adapter's own widest matching tier) for a plausibly-missed same-park OSM match under a different name.

Manual eyeball of the sampled names/districts: all plausible real park names/green-space labels for their district (Konya: Selçuklu/Meram/Karatay; Ordu: Fatsa/Altınordu/Ünye/Perşembe area names). The wider-radius scan flagged 10/30 Konya and 7/20 Ordu new-canonical records with an OSM park within the extended radius — inspected individually: matches were themselves generically-named (`İsimsiz park`) or clearly distinct-but-nearby features (e.g. a satellite green space ~160m from a large named park complex), consistent with the adapters' own conservative matching tiers correctly leaving genuinely ambiguous cases for review rather than a systemic reconciliation bug. **No systematic bug found — sample judged clean, merge proceeded.**

### 2. Generic municipal merge layer

`scripts/merge-municipal-sources.mjs` — reads the nationwide baseline plus a declarative list of adapter preview files (`MUNICIPAL_SOURCES`: currently Konya + Ordu, each just `{sourceCode, province, previewPath}`), normalizes each adapter's already-uniform preview shape (`matched[]`, `newCanonicalParks[]`, `review[]`, `rejectedNonPark[]`) into a generic `{source_code, matched, new_canonical, review, rejected}` contract, and applies one shared set of merge rules — no per-city branches:
- **MATCHED** → push the municipal `source_ref` onto the existing canonical park's `source_refs`; refuses (throws) if the adapter's claimed `osm_id` doesn't exactly match the baseline park's `osm_id` (would mean silently overwriting identity); name/coordinates/id never touched. Name-upgrade candidates were **not** auto-applied — they remain a separate, still-pending decision (157 Konya + 10 Ordu).
- **NEW_CANONICAL** → appended as-is; requires a unique id, ≥1 source_ref, a finite in-bbox coordinate, and `city` in the official 81-province set (throws otherwise). District is allowed to be genuinely empty (Ordu) but not `undefined`.
- **REVIEW** → never merged into canonical; collected into a combined, enriched backlog artifact (see §5).
- **REJECTED** → dropped (0 for both sources this round — neither adapter rejected any non-park records).

A future third adapter (Trabzon etc.) only needs one new entry in `MUNICIPAL_SOURCES` and a preview file in the same shape — no new merge code.

### 3. Konya + Ordu counts — recomputed, not forced

```
nationwide canonical before:  24,833
Konya safe new:                1,425
Ordu safe new:                    84
--------------------------------------
expected new total:            1,509   -> matched exactly
nationwide canonical after:   26,342   -> matched exactly
municipal source refs added:   1,821 (1,727 Konya + 94 Ordu)  -> matched exactly
```
No discrepancy from the predicted numbers — nothing needed forcing or explaining away.

### 4. Cross-source integrity (recomputed independently from the merged file on disk, not from the merge script's own self-report)

```
duplicate canonical id:              0
duplicate osm_id:                    0
duplicate source_code+external_id:   0   (27,547 total refs = 25,726 baseline + 1,821 new, all distinct)
invalid canonical coordinate:        0
province outside official 81 registry: 0
OSM deterministic ID changes:        0
```
Also verified directly against the merged file:
```
Konya source refs preserved exactly:   1,727 (1,727 distinct external_ids)
Ordu source refs preserved exactly:       94 (94 distinct external_ids)
İzmir municipal-only preserved:           83 (unchanged)
Fresh OSM-backed count unchanged:     24,750 (unchanged — merge only added rows, never touched OSM identity)
```
Composition — matches the predicted breakdown exactly:
```
OSM-backed:                  24,750
İzmir municipal-only:            83
Konya municipal-only (safe):  1,425
Ordu municipal-only (safe):      84
------------------------------------
total canonical:              26,342
```
Spot-checked 5 Konya MATCHED entries directly: `name`, `osm_id`, `latitude`/`longitude` all byte-identical before/after; `source_refs` grew from 1 to 2 with the new entry's `source_code` = `konya_acikveri_parklar` — confirms MATCHED never overwrites existing identity, only attaches evidence.

### 5. Review coverage — nothing discarded

`data/park-enrichment/.cache/municipal-review-backlog.json` (gitignored) — combined, enriched artifact, **525 records** (Konya 411 + Ordu 114, matches exactly, no discrepancy to explain), each carrying `source_code`, `external_id`, `name`, `province`, `district`, `latitude`/`longitude`, `review_reason`, and `osm_candidates[]` (each with `canonical_id`, `osm_id`, `name`, a freshly-computed `distance_m`, and a Levenshtein-based `name_similarity` in [0,1] where a comparison name exists) — the merge script resolved every OSM candidate id back to its real coordinates to compute distance/similarity once, generically, rather than trusting each adapter to have pre-computed it. Breakdown:
```
multiple_osm_candidates:          69  (41 Konya + 28 Ordu)
name_conflict_at_same_location:   37  (32 Konya + 5 Ordu)
shared_osm_target_conflict:      419  (338 Konya + 81 Ordu)
```
None of these 525 records were added to the canonical registry — they remain resolvable later (e.g. a future pass with tighter human-in-the-loop review, or a name-similarity threshold).

### 6. Architecture note

No refactor of `build-nationwide-canonical.mjs`/`build-*-canonical.mjs` was done — per instruction, only the new generic merge layer (`merge-municipal-sources.mjs`) was added on top, consuming the existing per-adapter preview shape as-is. The direction (source registry → adapter → normalized candidate schema → generic reconciliation → generic municipal result → nationwide merger) is now partially real: the last two stages (generic municipal result shape, generic merger) exist and work for 2 real sources. Adapter-internal reconciliation (OSM matching tiers, taxonomy filtering) is still per-source code, by design — the merge layer only starts once an adapter has already produced the `matched/new_canonical/review/rejected` shape.

### 7. Files added/changed this milestone

- `scripts/audit-municipal-sample.mjs` (new) — sample QA, read-only.
- `scripts/merge-municipal-sources.mjs` (new) — generic merge layer.
- `data/park-enrichment/.cache/nationwide-canonical-preview.json` — **overwritten in place** with the merged result (24,833 → 26,342 parks). This is the pipeline's own gitignored cache artifact, regenerable from scratch via `build-nationwide-canonical.mjs` + this merge script; a full pre-merge backup was kept at `data/park-enrichment/.cache/nationwide-canonical-preview.pre-municipal-merge.json.bak` (gitignored) in case of rollback.
- `data/park-enrichment/.cache/municipal-sample-audit.json` (new, gitignored) — full sample audit detail.
- `data/park-enrichment/.cache/municipal-review-backlog.json` (new, gitignored) — combined 525-record review artifact.
- `data/park-enrichment/.cache/municipal-merge-report.json` (new, gitignored) — merge script's own summary/invariants output.
- Konya's and Ordu's individual preview files, raw caches, and adapter scripts are **unchanged** — nothing was redone.

### 8. DB / git

No DB writes (no importer run, no `--commit`). No git commit, no push — only the new scripts are untracked in git; all generated preview/review/report data stays under `.cache/` (gitignored). `git status --short` at the end of this milestone:
```
?? data/municipal-park-sources.json
?? data/park-enrichment/progress.json
?? docs/PARK_DATA_CHECKPOINT.md
?? docs/municipal-park-enrichment-roadmap.md
?? scripts/audit-municipal-sample.mjs
?? scripts/build-konya-canonical.mjs
?? scripts/build-ordu-canonical.mjs
?? scripts/download-konya-parks.mjs
?? scripts/download-ordu-parks.mjs
?? scripts/merge-municipal-sources.mjs
```

## Milestone: Trabzon Adapter Built, Sample-Audited, and Merged (2026-09-21)

Third municipal source, explicit direction received to implement it directly (registry already confirmed SAFE_OPEN, 57 Point features, OBJECTID+ADI only, no district — no broad re-discovery needed, only the exact endpoint/schema re-verified).

### Registry re-check (before any new fetch)
```
source_code:  trabzon_acikveri_parklar (data/municipal-park-sources.json)
resource_url: https://acikveri.trabzon.bel.tr/dataset/ed40a618-1a58-4879-a77f-4c0219aaa9a9/resource/394ec651-8d36-45e7-9e4c-bfa3853b8fae/download/park.geojson
license_url:  https://acikveri.trabzon.bel.tr/license (SAFE_OPEN, ULASAV template, re-verified 2026-09-21)
```
`scripts/download-trabzon-parks.mjs` (new, same shape as Konya/Ordu's downloaders) fetched and cached: **57 features confirmed** (matches the registry exactly, no drift), geometry `Point`, properties `{OBJECTID, ADI}` only. Cached under `data/park-enrichment/.cache/trabzon/` (gitignored).

### Identity
`OBJECTID` verified **non-null and unique across all 57 features** before being trusted as `external_id` — no missing/duplicate case existed this time (unlike Ordu), so no records needed to be stopped for review on identity grounds.

### District (source has none — spatially derived, never name-guessed)
New shared module `scripts/district-boundaries.mjs` (same containment-first/nearest-fallback-second shape as `province-boundaries.mjs`, one ADM level down). Key subtlety: Turkish ADM2 district names are **not globally unique** — e.g. both Trabzon and Manisa have a district named "Köprübaşı" at completely different coordinates (verified directly: Trabzon's bbox ~lon 40.03–40.19/lat 40.57–40.83, Manisa's ~lon 28.17–28.60/lat 38.64–38.84). `districtsForProvince()` scopes candidate districts **geometrically** (a district's bbox center must fall inside the target province polygon), never by name string — this correctly returned exactly Trabzon's real 18 districts (Akçaabat, Araklı, Arsin, Beşikdüzü, Çarşıbaşı, Çaykara, Dernekpazarı, Düzköy, Hayrat, Köprübaşı, Maçka, Of, Ortahisar, Sürmene, Şalpazarı, Tonya, Vakfıkebir, Yomra), with no cross-province leakage. Result: **57/57 districts resolved by direct point-in-polygon containment, 0 via nearest-fallback, 0 unresolved.**

### Point geometry validation
Every point checked: finite lon/lat, inside the Turkey bbox, resolves to Trabzon province via containment. A diagnostic (not auto-correcting) lon/lat-swap check was added to `invalidCoordinates` reporting for defense-in-depth — unused this run since 0 coordinates were invalid (all 57 valid on first check).

### Matching — reused the exact Konya-shape generic reconciliation (Point source, 25m/150m tiers), no new thresholds invented. Generic-named candidates never aggressively matched to a specifically-named OSM park (same `isGenericName`/conflict rule as Konya/Ordu). MATCHED never touches an existing canonical park's coordinate — only appends a `source_ref`; this is enforced structurally by `merge-municipal-sources.mjs`, not something the adapter has to special-case, and was independently re-checked in the sample audit (`matched_entry_carries_no_coordinate_fields` check on all 15 sampled MATCHED records — true for all).

### Full integration report
```
source:                       trabzon_acikveri_parklar
raw features:                 57
park candidates:              57
valid geometry:                57
matched existing canonical:    16
new canonical:                 29
review:                        12   (5 multiple_osm_candidates, 7 name_conflict_at_same_location)
rejected:                        0
duplicate source records:        0
invalid coordinates:              0
province mismatch:               0
district resolved:               57
district missing:                 0
source refs produced:            45   (16 matched + 29 new)
canonical total before:      26,342
canonical total after:       26,371
license: Trabzon Açık Veri Lisansı (ULASAV template, confirmed by direct fetch)
```

### Sample quality check (before merge)
`scripts/audit-trabzon-sample.mjs` (new, same fixed-seed mulberry32 method as the Konya/Ordu sampler) — with only 57 raw features, sampled a high percentage: **20/29 (69%) NEW_CANONICAL, 15/16 (94%) MATCHED, 12/12 (100%) REVIEW.** Result: **0 issues across all 47 sampled records.** Manual eyeball: all names real and plausible (e.g. `ALTINDERE VADİSİ MİLLİ PARKI`, `UZUNGÖL MACERA PARKI`, `BOZTEPE PARKI`), districts correctly Trabzon districts (Of, Akçaabat, Çaykara, Maçka, Ortahisar, etc.), MATCHED name-upgrade pattern consistent with Konya/Ordu (generic OSM names like `İsimsiz park`/`Park` gaining specific municipal names as evidence). The wider-radius (300m) missed-match scan flagged **0/20** new-canonical records — no systemic reconciliation issue. **Sample judged clean, merge proceeded.**

### Merge — idempotency fix required
Re-running `scripts/merge-municipal-sources.mjs` with Trabzon added to `MUNICIPAL_SOURCES` would have tried to re-apply Konya's and Ordu's MATCHED/NEW_CANONICAL onto a baseline that already contains them (the file was overwritten in place by the previous milestone) — this would have thrown duplicate-id/duplicate-source-ref errors, or worse, silently double-counted if the checks were weaker. Fixed by making the script check `nationwidePreview.summary.municipalSourcesMerged` and skip re-applying any source already present there (still re-reads that source's preview file to keep the combined review/rejected backlog complete — a read, not a redo of the adapter itself). Verified this worked correctly, not just assumed:
```
Konya municipal-only after this merge:   1,425  (unchanged — NOT 2,850; confirms no double-application)
Ordu municipal-only after this merge:       84  (unchanged)
Trabzon municipal-only after this merge:    29  (newly added)
```

### Nationwide counts — recomputed independently from the merged file on disk
```
nationwide canonical before Trabzon: 26,342
Trabzon safe new:                        29
--------------------------------------------
nationwide canonical after:          26,371   -> matches exactly, no discrepancy
```
Composition:
```
OSM-backed:                  24,750  (unchanged)
İzmir municipal-only:            83  (unchanged)
Konya municipal-only:         1,425  (unchanged)
Ordu municipal-only:             84  (unchanged)
Trabzon municipal-only:          29  (new)
------------------------------------
total canonical:             26,371
```

### Global invariants — recomputed independently from the merged file, not the merge script's self-report
```
duplicate canonical id:                0
duplicate osm_id:                      0
duplicate source_code+external_id:     0   (27,592 total refs, all distinct)
invalid canonical coordinate:          0
province outside official 81 registry: 0
OSM deterministic ID changes:          0
```
Per-source ref counts verified separately, each exactly matching its adapter's own claim:
```
İzmir municipal-only parks:               83  (unchanged, still evidence-preserving)
Konya source refs:                     1,727  (1,727 distinct external_ids — unchanged)
Ordu source refs:                         94  (94 distinct external_ids — unchanged)
Trabzon source refs:                      45  (45 distinct external_ids — new)
```

### Review backlog — Trabzon's 12 appended, nothing discarded
`municipal-review-backlog.json` now totals **537** records (411 Konya + 114 Ordu + 12 Trabzon — matches exactly):
```
multiple_osm_candidates:          74  (41 Konya + 28 Ordu + 5 Trabzon)
name_conflict_at_same_location:   44  (32 Konya + 5 Ordu + 7 Trabzon)
shared_osm_target_conflict:      419  (338 Konya + 81 Ordu + 0 Trabzon)
```

### Architecture — confirmed generic, no per-city merge code added
Adding Trabzon required exactly one change to `merge-municipal-sources.mjs`'s declarative `MUNICIPAL_SOURCES` array (`{sourceCode, province, previewPath}`) plus the idempotency fix above (which itself is generic — applies uniformly to any source, not Trabzon-specific). No new MATCHED/NEW_CANONICAL/REVIEW rule branches were added.

### Files created/changed this milestone
- `scripts/download-trabzon-parks.mjs` (new)
- `scripts/build-trabzon-canonical.mjs` (new)
- `scripts/district-boundaries.mjs` (new, shared module — usable by future point-source adapters lacking a district field)
- `scripts/audit-trabzon-sample.mjs` (new)
- `scripts/merge-municipal-sources.mjs` (edited — Trabzon registry entry + idempotency fix)
- `data/park-enrichment/.cache/trabzon/{manifest.json,parklar.geojson,license.html,trabzon-canonical-preview.json,trabzon-sample-audit.json}` (new, gitignored)
- `data/park-enrichment/.cache/nationwide-canonical-preview.json` — overwritten in place again (26,342 → 26,371); pre-Trabzon backup kept at `nationwide-canonical-preview.pre-trabzon-merge.json.bak` (gitignored)
- `data/park-enrichment/.cache/municipal-review-backlog.json` — regenerated, now 537 records (gitignored)
- `data/park-enrichment/.cache/municipal-merge-report.json` — regenerated (gitignored)
- Konya's and Ordu's adapter scripts, raw caches, and preview files: **unchanged, not redone.**

### Last successful command
```
node scripts/merge-municipal-sources.mjs
```
Output: `nationwideCanonicalBefore: 26342, nationwideCanonicalAfter: 26371, totalSafeNewCanonical: 1538 (cumulative), totalMatched: 328 (cumulative), totalReviewPreserved: 537, totalRejected: 0` — Konya/Ordu correctly reported as already-merged (0 newly applied this run), Trabzon newly applied (16 matched + 29 new). All invariants and cross-checks clean, then independently re-verified from the merged file on disk via a separate inline script (see above).

### DB / git
No DB writes, no importer run, no `--commit`. No git commit, no push. `git status --short`:
```
?? data/municipal-park-sources.json
?? data/park-enrichment/progress.json
?? docs/PARK_DATA_CHECKPOINT.md
?? docs/municipal-park-enrichment-roadmap.md
?? scripts/audit-municipal-sample.mjs
?? scripts/audit-trabzon-sample.mjs
?? scripts/build-konya-canonical.mjs
?? scripts/build-ordu-canonical.mjs
?? scripts/build-trabzon-canonical.mjs
?? scripts/district-boundaries.mjs
?? scripts/download-konya-parks.mjs
?? scripts/download-ordu-parks.mjs
?? scripts/download-trabzon-parks.mjs
?? scripts/merge-municipal-sources.mjs
```

## Milestone: Generic Config-Driven Municipal Ingestion Framework (2026-09-21)

**Goal:** stop writing a bespoke `build-<city>-canonical.mjs` per municipality. Use Konya/Ordu/Trabzon as reference implementations to build the smallest practical config-driven engine, then prove it reproduces all three exactly before trusting it for anything new.

### 1. Source-specific vs. generic split (analysis)

Compared all three existing adapters line by line. Genuinely source-specific: the endpoint URL, id/name/taxonomy/district field names, geometry type (Point vs MultiPolygon), the OSM-matching radius tiers (25m/150m for point sources, 100m/300m for Ordu's polygon source), whether/how district is resolved (Konya: source field + Turkish title-casing; Ordu: none, source has no field and the original adapter never attempted spatial resolution; Trabzon: spatial, via the district-boundaries.mjs module built for it), and — a real find, see §4 — the *order* of two review-classification checks. Everything else (fetch/cache shape, per-feature soft identity validation, geometry/coordinate validation, province containment+nearest-fallback, the MATCHED/NEW_CANONICAL/REVIEW/REJECTED classification itself, deterministic UUID generation, output shape) is identical across all three and is now generic.

### 2. Files added

- `data/municipal-ingestion-configs.json` — the run-configuration layer. Explicitly documented as layered **on top of** `data/municipal-park-sources.json` (the research/discovery registry) rather than merged into it — the discovery file stays single-purpose and isn't touched, avoiding any repeat of the earlier subagent-overwrite incident. Contains one config object per runnable source; a row can only be `enabled:true` if its `license_status` is `SAFE_OPEN`.
- `scripts/municipal-ingestion-engine.mjs` — the generic pipeline as one exported `runIngestion(config, ...)` function: per-feature soft schema/identity validation (never throws mid-run, records `invalidGeometry` with a reason and excludes — reproduces both Ordu's messy-2-rows case and Trabzon's fully-clean case with the same code path), taxonomy filter (config-driven field+allowlist, or none), Point/MultiPolygon geometry extraction (point-on-surface for polygons), province containment+nearest-fallback, three district-resolution modes (`source_field` / `spatial` / `none`), tiered OSM reconciliation, MATCHED/NEW_CANONICAL/REVIEW classification, deterministic canonical UUIDs. Output shape is byte-compatible with what `scripts/merge-municipal-sources.mjs` already reads.
- `scripts/run-municipal-adapter.mjs` — CLI: `node scripts/run-municipal-adapter.mjs <source_code>`. Writes to `<cache_dir>/<source_code>-generic-preview.json` — a **different filename** than the original `<city>-canonical-preview.json` outputs, so regression runs can never clobber the already-merged, verified data.

The three original scripts (`build-konya-canonical.mjs`, `build-ordu-canonical.mjs`, `build-trabzon-canonical.mjs`) and their download scripts are **kept on disk, unchanged** — they remain the historical reference and are not deleted or altered.

### 3. Regression validation — mandatory gate, run before trusting the engine for anything

Ran the generic engine for all three reference sources via `node scripts/run-municipal-adapter.mjs <source_code>`, writing to the separate `*-generic-preview.json` files (never touching the merged `nationwide-canonical-preview.json` or the original preview files). Diffed exhaustively against the already-verified originals — not just summary counts:

```
KONYA:   matched 302, new 1425, review 411   -> EXACT MATCH (counts, breakdown 41/32/338, all deterministic UUIDs, all matched pairs, all review pairs, all name-upgrade candidates, all coordinates/districts/names)
ORDU:    matched 10, new 84, review 114      -> EXACT MATCH (see §4 for the one real divergence found and fixed before this passed)
TRABZON: matched 16, new 29, review 12       -> EXACT MATCH (counts, breakdown 5/7/0, all deterministic UUIDs, all matched pairs, all review pairs, all name-upgrade candidates, all coordinates/districts/names)
```
Diff method: new-canonical-park id sets compared for exact set equality (not just count), matched `(canonical_id, external_id)` pairs compared as sets, review `(reason, external_id)` pairs compared as sets, name-upgrade candidates compared, and every new park's `latitude`/`longitude`/`district`/`name` compared field-by-field against its original counterpart by shared deterministic id. **0 mismatches across all three sources on every one of these checks.**

### 4. A real divergence was found — not silently accepted, per instruction

First generic run for Ordu passed on the three top-line counts (10/84/114) but its review **reason breakdown** came out as `28 multiple_osm_candidates / 26 name_conflict_at_same_location / 60 shared_osm_target_conflict` instead of the verified `28/5/81`. Root cause, found by reading both original scripts side by side: Konya's and Trabzon's adapters check the name-conflict rule **before** grouping candidates by shared OSM target; Ordu's original adapter checks the shared-target grouping **first**, and only applies the name-conflict check to whichever single candidate survives as sole claimant of its OSM target. This never changes whether a record reaches canonical (both orders send it to REVIEW either way, never MATCHED) — but it does change *which* review reason it's filed under, which matters for anyone triaging the backlog by reason later. Fixed by adding a per-source `matching_check_order` config field (`"name_conflict_before_grouping"` default, `"grouping_before_name_conflict"` for Ordu) rather than picking one behavior and explaining away the other. Re-ran; Ordu's breakdown now matches 28/5/81 exactly.

### 5. Balıkesir — confirmed still blocked, no identity invented

Re-checked `data/municipal-park-sources.json`: `balikesir_yesil_alanlar` — `external_id_available: false`, confirmed in the KML source itself in the earlier research pass (no `id` attribute on any of its 1,542 Placemarks). **Per explicit instruction, no hash-of-name/coordinate synthetic key was created.** Classified `BLOCKED_IDENTITY` (see §7) and left out of `municipal-ingestion-configs.json` entirely — not given an `enabled:false` placeholder row that could later be flipped on by mistake, since there is no config that could make it safe to run. Unblocking requires either the municipality adding a real id field to their export, or an explicit user decision to accept a different identity strategy (not decided here).

### 6. Pending name-upgrade candidates — documented, not applied

Aggregated all 174 across the three merged sources into `data/park-enrichment/.cache/pending-name-upgrade-audit.json` (gitignored):
```
total: 174   (157 Konya + 10 Ordu + 7 Trabzon — matches exactly)
```
- **Rule that generated them:** `osmGeneric && !candidateGeneric` — proposed only when the existing OSM-backed canonical park's name is generic (`İsimsiz park` / `Yeşil Alan` / `Park`, per `isGenericName()`) AND the municipal source record at the same reconciled location has a specific, non-generic name.
- **Provenance:** every candidate carries `canonical_id` + `osm_id` (the exact existing park) + `evidence_external_id` (the exact municipal source record proposing the new name) — fully traceable.
- **Verified fresh, not assumed:** re-checked all 174 against the current `nationwide-canonical-preview.json` — every target park still exists and its current `name` still exactly equals the recorded `old_name`. **0 stale entries** (none of the 174 have silently drifted since being proposed).
- **Independent of the municipal-only merge, confirmed by code inspection:** `scripts/merge-municipal-sources.mjs`'s `applyMunicipalResult()` only ever pushes a `source_ref` onto a MATCHED park — it never reads or writes `safeNameUpgradeCandidates`. The merge already ran three times (Konya, Ordu, Trabzon) and **no canonical park's `name` field was touched** by any of it.
- **Not applied.** No canonical park has been renamed. This remains a separate, explicit decision for later.

### 7. Batch eligibility across all 30 registered sources

Read `data/municipal-park-sources.json` in full (30 rows: 29 büyükşehir + already-separate Kadıköy note). Classified every source against the required criteria (SAFE_OPEN + machine-readable + usable geometry + stable external identity + park-only-or-safely-filterable taxonomy). One live schema check was done — İstanbul, the one source whose registry fields were still marked `unknown` — using the CKAN `resource_show` API to resolve its real download URL (the registry's `resource_url` was a landing page, not a file) and fetching the actual 52MB GeoJSON to inspect its schema directly (this is verification, not adapter-building — no code was written for İstanbul).

```
SUCCESS_CONFIG_ONLY (3 — already integrated, this milestone's reference set):
  konya_acikveri_parklar, ordu_acikveri_parklari, trabzon_acikveri_parklar

BLOCKED_IDENTITY (2):
  balikesir_yesil_alanlar — confirmed (already known): 1,542 KML Placemarks, zero have an id attribute.
  ibb_kentsel_acik_yesil_alan (İstanbul) — NEWLY VERIFIED this session: real download URL is
    https://data.ibb.gov.tr/dataset/82e809cf-9465-407a-91cd-ac745d6fbc95/resource/41ddb7a6-6931-4176-9614-2c2892da5307/download/yaysis_mahal_geo_data.geojson
    (1,371 features, Polygon+MultiPolygon mixed, properties are ONLY {MAHALLE, TUR, ILCE, WKT_GEOM} —
    MAHALLE actually holds the park NAME despite its name meaning "neighborhood"; no id field anywhere,
    not in properties and not as a GeoJSON top-level feature.id). Taxonomy IS cleanly filterable
    (TUR=="Park" -> exactly 495/1371 features, other TUR values are clearly non-park: Kamu, Cadde,
    Meydan, Karayolu, Metro Çıkışı, Hatıra Ormanı, Ağaçlandırma Sahası, Mesire Alanı, Koru, Kent
    Ormanı) and MAHALLE+ILCE happens to be unique across all 1,371 rows in this snapshot — but per the
    SAME "do not fabricate identity from mutable name/coordinate fields" rule already applied to
    Balıkesir, a name+district combo is not a stable id (a municipality renaming/re-tagging a park
    between refreshes would silently break every source_ref) and was NOT used as one. Blocked pending
    an explicit identity-strategy decision, same as Balıkesir. (Separately would also need the engine's
    geometry_type support extended to plain "Polygon", not just "MultiPolygon" — a small, real addition,
    not done here since it's moot until identity is resolved.)

NEEDS_SMALL_PARSER / different reconciliation strategy (1):
  gaziantep_acikveri_parklar — SAFE_OPEN, stable external id, district available, but
    geometry_available:false entirely (name/district/neighborhood/area only, confirmed in earlier
    research). Our entire pipeline (province/district resolution, OSM tiered-radius reconciliation) is
    geometry-first; this source would need name+district-based reconciliation instead — a genuinely
    different matching strategy, not a config variation of the existing engine. Deferred, not attempted.

BLOCKED_LICENSE (3):
  manisa_acikveri_parklar_kml — license_status LIKELY_USABLE_NEEDS_REVIEW, not SAFE_OPEN. Per instruction
    ("unknown-license sources must never become enabled automatically"), stays blocked until someone
    directly fetches and reads its license page the way Konya/Ordu/Trabzon/Balıkesir's were.
  sakarya_acikveri_park_alanlari — same LIKELY_USABLE_NEEDS_REVIEW license gap; also csv_no_geometry
    (would be BLOCKED_SCHEMA too even if the license were confirmed).
  bursa_acikyesil_parklar — license_status explicitly UNUSABLE (confirmed in the original research
    pass), despite an otherwise clean geojson/point/stable-id/no-district shape that would likely have
    been SUCCESS_CONFIG_ONLY under a different license.

BLOCKED_SCHEMA (21 — no machine-readable resource exists at all; this is the 22-row tier-D set
  MINUS Bursa, which is tier-D but reclassified BLOCKED_LICENSE above since it does have a
  machine-readable geojson resource, just an explicitly closed license):
  Ankara (x2 sources), Kocaeli, Denizli, Muğla, Tekirdağ, Antalya, Adana, Mersin, Samsun, Kayseri,
  Eskişehir, Diyarbakır, Şanlıurfa, Hatay, Malatya, Mardin, Erzurum, Van, Aydın, Kahramanmaraş —
  each is either interactive-map-only (never treated as equivalent to a real downloadable/API source,
  per an earlier explicit decision), PDF-only, or nothing was found at all.
```
Total: 3 + 2 + 1 + 3 + 21 = **30**, matching `data/municipal-park-sources.json`'s row count exactly.

**Result: zero additional sources currently qualify for config-only onboarding.** Every SAFE_OPEN + machine-readable source beyond the existing three fails at least one hard requirement (İstanbul and Balıkesir: no stable identity; Gaziantep: no geometry for our matching strategy; Manisa/Sakarya/Bursa: license not confirmed open or explicitly closed). This is reported honestly rather than forcing an onboarding to satisfy the task — no config-only run was attempted this milestone beyond the mandatory Konya/Ordu/Trabzon regression, because none exists to attempt.

## Next Exact Step

**DONE: generic config-driven ingestion framework built, regression-validated against all three reference sources (byte-for-byte, see Milestone above), and all 30 registered sources classified.** Nationwide canonical remains **26,371** (24,833 OSM/İzmir baseline + 1,425 Konya + 84 Ordu + 29 Trabzon) — **unchanged this milestone**, since zero additional sources qualified for config-only onboarding (see §7). No merge was run this milestone beyond the regression comparison files (`*-generic-preview.json`, never fed into `merge-municipal-sources.mjs`). All invariants remain clean (unchanged from the Trabzon merge). Do NOT start a fourth municipality without explicit direction.

Open items for the user, now with concrete next steps for each:
- **174 pending name-upgrade candidates** (157 Konya + 10 Ordu + 7 Trabzon), fully documented with verified provenance in `data/park-enrichment/.cache/pending-name-upgrade-audit.json` — still **not applied**. Explicit decision needed: apply them (would change 174 existing canonical parks' `name` field from generic to specific) or leave as evidence-only.
- **Balıkesir** and **İstanbul**: both `BLOCKED_IDENTITY` — no stable id field exists in either source's actual schema (verified directly for both, not assumed). Need an explicit user decision on identity strategy (accept a synthetic key with a documented caveat? treat as permanently out of scope? wait for the municipality to add a real id?) before either can be unblocked — the engine will not run for a `SAFE_OPEN:false`-equivalent identity gap on its own.
- **Gaziantep**: `NEEDS_SMALL_PARSER` — has a stable id and SAFE_OPEN license, but no geometry at all; would need a genuinely different name+district reconciliation strategy, not a config variation. Real future work, not attempted here.
- **Manisa, Sakarya**: `BLOCKED_LICENSE` — need someone to directly fetch and read their license pages (same method already used for Konya/Ordu/Trabzon/Balıkesir) before they can even be considered.
- The **537-record** combined review backlog is preserved but unresolved beyond its sample audits.

If resuming with no new user direction available (e.g. after a context reset): do NOT start a fourth municipality, do not apply name upgrades, do not attempt İstanbul/Balıkesir/Gaziantep on your own initiative. Report the current state (framework built and validated, 26,371 unchanged, full classification already in this file and `progress.json`) and wait.

## Resume Instructions

```
Read docs/PARK_DATA_CHECKPOINT.md and data/park-enrichment/progress.json and continue exactly from the recorded next step. Do not redo completed work.
```

## Git Status

```
?? data/municipal-ingestion-configs.json
?? data/municipal-park-sources.json
?? data/park-enrichment/progress.json
?? docs/PARK_DATA_CHECKPOINT.md
?? docs/municipal-park-enrichment-roadmap.md
?? scripts/audit-municipal-sample.mjs
?? scripts/audit-trabzon-sample.mjs
?? scripts/build-konya-canonical.mjs
?? scripts/build-ordu-canonical.mjs
?? scripts/build-trabzon-canonical.mjs
?? scripts/district-boundaries.mjs
?? scripts/download-konya-parks.mjs
?? scripts/download-ordu-parks.mjs
?? scripts/download-trabzon-parks.mjs
?? scripts/merge-municipal-sources.mjs
?? scripts/municipal-ingestion-engine.mjs
?? scripts/run-municipal-adapter.mjs
```
No commits, no pushes this session. Last actual commit on `main` remains `f84d287` (nationwide PBF pipeline + İzmir reconciliation). All Konya/Ordu/Trabzon adapter data, the merged nationwide preview, and the new `*-generic-preview.json` regression outputs live under `data/park-enrichment/.cache/` (gitignored, correctly absent from this status).

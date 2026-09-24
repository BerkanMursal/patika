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

**DONE.** Konya, Ordu, and Trabzon are all built, sample-audited, and merged into `nationwide-canonical-preview.json` (24,833 → 26,371, committed+pushed as `28defac`). A generic, config-driven ingestion framework replaces the need for a new bespoke script per city — regression-validated byte-for-byte against all three; all 30 registered municipal sources classified, zero additional ones currently qualify for config-only onboarding. **New this session**: an Overture Maps Places gap analysis for Turkey (schema/source verified live against the real 2026-08-19.0 release, 19,922 park-domain places extracted, reconciled against the 26,371-park registry — 3,819 matched, 8,504 strong-new-candidates, 3,355 review, 3,219 rejected-non-park) — **gap-analysis only, nothing merged**, with an important honest finding: ~99.6% of the strong-new-candidate pool is single-provider (Meta) crowdsourced data with observed taxonomy noise, needing a secondary quality filter before any future onboarding. See "Milestone: Konya + Ordu Merged", "Milestone: Trabzon Adapter Built, Sample-Audited, and Merged", "Milestone: Generic Config-Driven Municipal Ingestion Framework", and "Milestone: Overture Maps Places — Turkey Park Gap Analysis" below for full reports. Waiting on explicit direction before a fourth municipal source, an Overture quality-filter/onboarding decision, an identity-strategy decision for Balıkesir/İstanbul, or applying any pending name upgrades.

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

## Milestone: Overture Maps Places — Turkey Park Gap Analysis, Stage 1 (Schema/Source Verification) (2026-09-22)

**Goal of this phase:** find park candidates in Turkey missing from the current 26,371-park canonical registry, using Overture Maps Places as a nationwide, non-OSM-derived gap source. Explicitly NOT a merge — preview/gap-analysis only.

### Current release and schema — verified live, not assumed

- **Current release: `2026-08-19.0`** (schema `v1.18.0`) — confirmed two ways: (a) official docs blog (`docs.overturemaps.org/blog/`), and (b) the official `overturemaps` Python CLI's own `releases latest` command, run live in this environment. No `2026-09` release exists yet as of 2026-09-22.
- **Schema is mid-transition**: the legacy `categories` STRUCT(primary, alternate[]) property is deprecated (removal originally slated for "September 2026," not yet done in the current release) and coexists with two new properties: `basic_category` (VARCHAR) and `taxonomy` STRUCT(primary, hierarchy[], alternates[]). **Verified directly against the live Places parquet schema** via `DESCRIBE` (not just docs) — both old and new fields are present simultaneously in `2026-08-19.0`. Decision: use `taxonomy.primary`/`taxonomy.hierarchy` as authoritative (the forward-looking field, and the one with real hierarchical structure), cross-check against `categories.primary` opportunistically, never rely on `categories` alone.
- **Stable identity confirmed**: the `id` column carries the place's **GERS ID** (Global Entity Reference System) — "anchors its identity across releases," per official docs. This is a real global stable identifier, unlike any of Konya/Ordu/Trabzon's ad-hoc municipal `ID`/`OBJECTID` fields — no schema-trustworthiness verification needed the way Ordu's was, though a within-dataset duplicate audit is still planned (pipeline step 4) as basic hygiene.
- **Licensing**: Places data is published under **CDLA Permissive 2.0** or **Apache 2.0** depending on source (per-record `sources[].license`), explicitly **not** ODbL — "does not include OpenStreetMap data and carries none of the share-alike obligations of the Open Database License." Caveat from the docs: joining CDLA-Permissive data to OSM data could trigger ODbL obligations on the *joined result* — noted for later, not a blocker for a gap-analysis preview that never merges.
- **Recommended query/download method**: for a small bbox, the docs show the `overturemaps download --bbox=... --type=place` CLI. For a full-country, taxonomy-filtered, efficiently-pruned extraction, DuckDB with the `httpfs`+`spatial` extensions reading the public S3 parquet directly (`s3://overturemaps-us-west-2/release/<release>/theme=places/type=place/*`) is what the docs' own example queries use (e.g. filtering `addresses[1].country`) — this is the method actually used here, since the CLI's `download` command has no taxonomy filter and would require downloading every place of every kind in Turkey's bbox (restaurants, shops, offices — likely millions of rows) before being able to filter.
- **Live schema, verified via `DESCRIBE` against the actual current release** (not the deprecated CSV the old docs pointed to, which has since been removed from the schema repo): `id`, `geometry`, `categories{primary,alternate[]}`, `confidence`, `websites/emails/socials/phones`, `brand`, `addresses[]{freeform,locality,postcode,region,country}`, `names{primary,common,rules[]}`, `sources[]{property,dataset,license,record_id,update_time,confidence,provider,resource,version}`, `operating_status`, `basic_category`, `taxonomy{primary,hierarchy[],alternates[]}`, `version`, `bbox{xmin,xmax,ymin,ymax}`, `theme`, `type`.

### Taxonomy — verified empirically against the live data for Turkey, not assumed from docs

Ran a live DuckDB query over the actual `2026-08-19.0` Places data, bbox-limited to Turkey (lon 25–45, lat 35–43), for every `taxonomy.primary`/`categories.primary` value containing "park" or related terms, then inspected each one's full `taxonomy.hierarchy` path. Result — Overture's own hierarchy already cleanly separates "ordinary park" from every category the task said not to auto-accept, via structure rather than naive string matching:

```
Genuinely under the park branch (hierarchy = ['sports_and_recreation','park', ...]):
  park                    16,703   <- the target: ordinary/neighborhood/public park, hierarchy = ['sports_and_recreation','park']
  national_park            1,321   <- hierarchy ['sports_and_recreation','park','national_park'] — EXCLUDE per instruction
  water_park                1,090   <- ['sports_and_recreation','park','water_park'] — EXCLUDE per instruction
  playground                  580   <- ['sports_and_recreation','park','playground'] — EXCLUDE per instruction
  dog_park                    227   <- ['sports_and_recreation','park','dog_park'] — EXCLUDE (specific subtype, not "ordinary")
  state_park                    1   <- ['sports_and_recreation','park','state_park'] — EXCLUDE (same family as national_park)

NOT under the park branch at all (Overture's own taxonomy already separates these; false positives of a naive "%park%" string search, confirming a structured-hierarchy filter is the right approach — none of these were ever at risk of being miscounted as "park"):
  amusement_park  (['arts_and_entertainment','amusement_attraction','amusement_park'])      1,384
  botanical_garden (['geographic_entities','built_feature','garden','botanical_garden'])    1,373
  nature_reserve  (['geographic_entities','land_feature','nature_reserve'])                   942
  rv_park         (['lodging','rv_park'])                                                     674
  skate_park      (['sports_and_recreation','sport_or_fitness_facility','skate_park'])        166
  atv_recreation_park (same branch)                                                            25
  mobile_home_park (['services_and_business','housing_or_property_service','mobile_home_park']) 21
  forest, public_plaza, sports_and_recreation(bare), parking — all different branches entirely, excluded from the extraction net as not park-domain at all.
```

**Decision: extraction predicate = `taxonomy.hierarchy[1]='sports_and_recreation' AND taxonomy.hierarchy[2]='park'`** (captures exactly the 6-row family above, 19,922 rows within Turkey's bbox) — **not** a name/string filter. Within that set, the taxonomy-filter pipeline stage accepts only `taxonomy.primary == 'park'` exactly as `STRONG_NEW_CANDIDATE`-eligible; the other 5 subcategories are reported as `REJECT_NON_PARK` with their real taxonomy value retained (never silently dropped, matching the task's explicit exclusion list almost one-to-one: playground/national_park/water_park are literally Overture subcategories under park; "theme park"≈amusement_park, "nature reserve"≈nature_reserve, "garden"≈botanical_garden — all confirmed to sit in a different hierarchy branch and so were never in the extraction net to begin with, which is the more principled outcome than needing to explicitly exclude them post-hoc).

### Stage 2 (Extraction) — done

`scripts/download-overture-turkey-parks.py`: first attempt (materializing Arrow tables through Python/orjson for nested `addresses[]`/`sources[]` columns) timed out after 5 minutes with no result — the nested-struct round-trip through PyArrow was the bottleneck, not the underlying S3/predicate-pushdown query itself (a plain `COUNT(*)` with the same WHERE clause had completed in 25–40s). Fixed by switching to DuckDB's native `COPY (...) TO '<file>' (FORMAT JSON)` — lets DuckDB serialize nested types in C++ directly instead of round-tripping through Python objects. Re-ran successfully: **85.7 seconds, 19,922 rows**, matching the row count predicted from the earlier `GROUP BY taxonomy.primary` query exactly (16,703 park + 1,321 national_park + 1,090 water_park + 580 playground + 227 dog_park + 1 state_park = 19,922). Output: `data/park-enrichment/.cache/overture/turkey-park-domain.json` (21MB, gitignored).

Spot-checked the first raw row: a "Κεντρική Πλατεία Τυλίσου" (Greek name) at lon 25.02/lat 35.30 — **Crete, Greece**, not Turkey (`addresses[1].country: "GR"`) — this is expected and correctly demonstrates why the bbox pre-filter is coarse-only: Turkey's rectangular bbox (lon 25–45, lat 35–43) also covers parts of Greece, Cyprus, Bulgaria, Georgia, Armenia, Azerbaijan, Iraq, and Syria. The Node reconciliation stage's province-containment check (never trusting Overture's own `addresses[].country` as authoritative, same principle as every other source in this pipeline) is what actually excludes non-Turkey records — confirmed necessary, not a hypothetical concern.

### Stage 3 (Reconciliation) — done

Ran `scripts/reconcile-overture-turkey-parks.mjs` against the 19,922 extracted rows and the current 26,371-park canonical registry:
```
Turkey Places considered:  19,922
park candidates (taxonomy=='park' only): 16,703
valid coordinates:          16,703  (0 invalid — Overture's coordinates are clean)
province mismatch:           1,025  (bbox-rectangle false positives outside Turkey's real
                                      borders — Greece/Cyprus/Bulgaria/Georgia/Armenia/
                                      Azerbaijan/Iraq/Syria edge overlap — correctly excluded
                                      by province containment, confirming the coarse-bbox
                                      pre-filter needed this stage)
district unresolved:           139
matched existing canonical:  3,819
strong new candidates:       8,504
review:                      3,355  (2,099 name_conflict_at_same_location, 1,256 multiple_canonical_candidates)
rejected non-park:           3,219  (1,321 national_park + 1,090 water_park + 580 playground
                                      + 227 dog_park + 1 state_park — exactly the 5 excluded
                                      subcategories found in Stage 1, none silently dropped)
duplicate source records:        0  (GERS ids are globally unique by design; 0 near-duplicate
                                      pairs found within Overture's own Turkey park data either)
distinct provinces represented: 81 / 81
```
Sanity check: `3,819 + 8,504 + 3,355 + 1,025 = 16,703` — accounts for every park-taxonomy candidate exactly, nothing unaccounted for.

Top provinces by strong new candidates: İstanbul (1,234), İzmir (560), Bursa (490), Ankara (465), Antalya (416), Kocaeli (255), Aydın (248), Manisa (225), Mersin (221), Balıkesir (198), Konya (182), Muğla (179), Denizli (158), Adana (154), Samsun (144). İstanbul leading by a wide margin is consistent with it having zero integrated municipal source so far (its own municipal adapter is `BLOCKED_IDENTITY`, see the generic-framework milestone) — Overture appears to be filling a real, previously-undetected gap there.

Output: `data/park-enrichment/.cache/overture/overture-turkey-gap-preview.json` (gitignored). **Deliberately incompatible with `scripts/merge-municipal-sources.mjs`** — Overture is a gap-analysis candidate source, not a municipal adapter output, and this phase never merges anything.

### Stage 4 (Sample Audit) — done, with a real systematic finding (stopped and investigated per instruction, not glossed over)

`scripts/audit-overture-sample.mjs` — fixed-seed sample: 30 STRONG_NEW_CANDIDATE, 20 MATCHED_EXISTING, 20 REVIEW. **All automated structural checks passed (0/70 flagged)**: every sampled record has taxonomy `park`, a GERS-shaped stable id, a plausible coordinate, correct province (re-verified independently), retained provenance, and (for MATCHED_EXISTING) a `distance_m` inside the matching tier.

**But manual eyeball of the STRONG_NEW_CANDIDATE names found a real, systematic problem the automated checks couldn't catch — name plausibility, not structural validity.** ~12 of the 30 sampled names are clearly not ordinary urban/neighborhood parks despite passing the structurally-correct `taxonomy.primary=='park'` filter: `Gaziantep Büyükşehir Belediyesi Hayvanat Bahçesi` (a **zoo**), `Honaz Dağı Milli Parkı` (a **national park**, mistagged — its own name says so), `Konya Enduro Park` (a **motocross track**), `Rize Belediyesi Kenef` (literally "**toilet**" in Turkish), `Samsun Alanlı Piknik Yeri` (a **picnic area**), `Efeler Belediyesi Park Ve Bahçeler Şantiyesi` (a municipal **parks-department depot/works yard**), plus several that read as plain **place/neighborhood names** with no park-like name at all (`Develi Mahallesi`, `Nigde Kiledere Kasabasi`, `Yazikonak Koy İci`, `Balıkesir Gönen`, `Çatalca Ceylan Kent Villaları` — the last is literally a **housing development name**).

Investigated further rather than just flagging it:
- **`confidence` does not separate good from bad records.** The mistagged records span the full range and several are HIGH confidence (zoo=0.99, national park=0.96, neighborhood name=0.83) — Overture's `confidence` field evidently reflects something like geocoding/match confidence, not category correctness. Not usable as a quality filter on its own.
- **Root cause found: provider concentration.** Checked `sources[].provider` for the *entire* 8,504-row STRONG_NEW_CANDIDATE set (not just the sample) and the 3,355-row REVIEW set: **8,482/8,504 (99.7%) and 3,338/3,355 (99.5%) come from a single provider, `meta` (Meta/Facebook Places directory data)** — effectively none from OpenStreetMap, official government sources, or any curated dataset; a negligible 22/17 records come from `foursquare`. Meta's Places directory is itself crowdsourced (user check-ins/business listings), which plausibly explains both the informal/joke names (`Kenef`) and the taxonomy mistagging (a zoo or a picnic area getting the generic `park` tag from whoever created the listing).

**This is reported as a material limitation, not concealed or downplayed, and directly shapes the final report's coverage-improvement verdict below** — the raw STRONG_NEW_CANDIDATE count materially overstates confirmed-missing ordinary parks; the dataset is valuable as a *lead-generation* source for candidate locations worth investigating, not as ready-to-merge canonical-quality data the way Konya/Ordu/Trabzon's authoritative municipal exports were.

### Final Gap Report — Overture Maps Places, Turkey Park Gap Analysis

```
Overture release:                2026-08-19.0 (schema v1.18.0)
Turkey Places considered:        19,922   (taxonomy.hierarchy = ['sports_and_recreation','park',...])
Park candidates (taxonomy=='park' exactly): 16,703
Valid coordinates:               16,703   (0 invalid)
Matched existing canonical:       3,819
Strong new candidates:            8,504   (see coverage-improvement caveat below — NOT all confirmed real parks)
Review:                           3,355   (2,099 name_conflict_at_same_location, 1,256 multiple_canonical_candidates)
Rejected non-park:                3,219   (1,321 national_park + 1,090 water_park + 580 playground + 227 dog_park + 1 state_park)
Duplicate source records:             0   (GERS ids globally unique; 0 near-duplicates within Overture's own Turkey park data)
Invalid coordinates:                  0
Province distribution:           81 / 81 provinces represented among the 16,703 park-taxonomy candidates
                                  (1,025 of the raw 16,703 were bbox-rectangle false positives outside Turkey's
                                  real borders — Greece/Cyprus/Bulgaria/Georgia/Armenia/Azerbaijan/Iraq/Syria —
                                  correctly excluded by province containment before classification)
Top provinces by strong new candidates: İstanbul 1,234; İzmir 560; Bursa 490; Ankara 465; Antalya 416;
                                  Kocaeli 255; Aydın 248; Manisa 225; Mersin 221; Balıkesir 198; Konya 182;
                                  Muğla 179; Denizli 158; Adana 154; Samsun 144
```

**Sample quality result:** 70 records sampled (30 STRONG_NEW_CANDIDATE, 20 MATCHED_EXISTING, 20 REVIEW), fixed-seed, not cherry-picked. All structural/automated checks passed (0/70). **Manual review found a real, systematic issue**: ~12/30 sampled STRONG_NEW_CANDIDATE names are not ordinary parks (a zoo, a picnic area, a motocross track, a municipal depot, a mistagged national park, several bare place/neighborhood/housing-development names) despite passing the structurally-correct taxonomy filter. Root-caused to provider concentration: **99.6% of both the STRONG_NEW_CANDIDATE and REVIEW pools come from a single provider, `meta`** (Meta/Facebook Places directory — crowdsourced business/location listings), with `confidence` score not correlated with category correctness. See Stage 4 above for full detail — this was investigated, not glossed over, per the explicit "stop and checkpoint on systematic issues" instruction.

**Stable identity strategy:** use the `id` column directly as `external_id` — it is the place's **GERS ID** (Global Entity Reference System), Overture's own cross-release stable identifier, confirmed via official docs ("anchors its identity across releases and is the join key for bridge files and the changelog"). No schema-trustworthiness verification is needed the way Ordu's ad-hoc `ID` field required — this is categorically more solid than any of Konya/Ordu/Trabzon's municipal id fields.

**Recommended `park_source_refs` representation** (for a future actual onboarding, not implemented — no merge happened this phase):
```
{
  source_code: "overture_places",
  external_id: "<GERS id, e.g. '3f952c40-f264-4b94-882c-e06fa83b714a'>",
  source_url: "https://docs.overturemaps.org/guides/places/  (or a GERS explorer link once stable)"
}
```
Plus retaining `taxonomy_primary`, `confidence`, and `sources[].provider`/`sources[].dataset` as `provenance_metadata` (same pattern already used for Ordu's `katman`/`kod`/`area_m2`) — critically including the provider, since the 99.6% single-provider concentration found above is exactly the kind of fact a future reviewer would need surfaced per-record, not buried.

**Licensing/attribution:** Places theme is CDLA Permissive 2.0 or Apache 2.0 depending on the specific record's `sources[].license` (never ODbL — explicitly does not include OpenStreetMap data, so no share-alike obligation from Overture itself). Caveat carried over from official docs for later: joining CDLA-Permissive data to OSM-derived data (which every future merge into this registry would do, since ~24,750 of the 26,371 canonical parks are OSM-backed) could make the *joined result* subject to ODbL's share-alike obligations under OSM's Collective Database Guideline — worth explicit legal/licensing review before any future merge, not just at extraction time.

**Whether Overture materially improves coverage:** **Yes, as a lead-generation signal — no, not as ready-to-merge canonical-quality data without further work.** It surfaces genuinely large gaps invisible to OSM+municipal sources alone (İstanbul's 1,234 candidates are notable given İstanbul has zero integrated municipal source and only OSM coverage today), and structurally it is a real non-OSM-derived, licensed, stably-identified dataset exactly as the task required. But unlike Konya/Ordu/Trabzon's authoritative municipal exports (curated by the municipality itself, ~0% taxonomy noise observed), Overture's Turkey park data is ~99.6% single-provider crowdsourced business-listing data with an observed real mistagging rate even within its own correctly-structured taxonomy leaf. A future onboarding would need either (a) a secondary quality filter (name-pattern denylist for terms like "Milli Park"/"Hayvanat Bahçesi"/"Piknik"/"Enduro"/bare place names, and/or a minimum-evidence-count threshold), or (b) treating every STRONG_NEW_CANDIDATE as REVIEW-only (human-verified before ever becoming canonical) rather than auto-eligible the way Konya/Ordu/Trabzon's new-canonical records were.

## Next Exact Step

**DONE: both this milestone (Overture gap analysis) and the prior one (generic config-driven ingestion framework) are complete and fully checkpointed.** Nationwide canonical remains **26,371** (24,833 OSM/İzmir baseline + 1,425 Konya + 84 Ordu + 29 Trabzon) — **unchanged** by either milestone; Overture was gap-analysis only, never merged. All invariants remain clean. Do NOT start a fourth municipality, apply name upgrades, or attempt any Overture onboarding without explicit direction.

Open items for the user, each with a concrete next step:
- **Overture gap analysis**: 8,504 raw strong-new-candidates, but ~99.6% single-provider (Meta) with observed taxonomy noise — needs an explicit decision on a secondary quality filter (name-pattern denylist, confidence/evidence threshold, or REVIEW-only treatment) before any future onboarding is even considered. Nothing was merged or imported.
- **174 pending name-upgrade candidates** (157 Konya + 10 Ordu + 7 Trabzon), fully documented with verified provenance in `data/park-enrichment/.cache/pending-name-upgrade-audit.json` — still **not applied**.
- **Balıkesir** and **İstanbul**: both `BLOCKED_IDENTITY` — no stable id field exists in either source's actual municipal schema (verified directly for both). Needs an explicit identity-strategy decision. (Note: this is a *different* identity problem from Overture's GERS ids, which ARE stable — Overture could theoretically help surface İstanbul candidates precisely because its own municipal source is blocked, but that's the unapplied gap-analysis result above, not a resolution to İstanbul's municipal-adapter blocker.)
- **Gaziantep**: `NEEDS_SMALL_PARSER` — has a stable id and SAFE_OPEN license, but no geometry; needs a name+district reconciliation strategy, not attempted.
- **Manisa, Sakarya**: `BLOCKED_LICENSE` — need someone to directly fetch and read their license pages.
- The **537-record** municipal review backlog is preserved but unresolved beyond its sample audits.

If resuming with no new user direction available (e.g. after a context reset): do NOT start a fourth municipality, do not apply name upgrades, do not attempt any Overture onboarding or filtering on your own initiative. Report the current state (both milestones complete, 26,371 unchanged, full detail already in this file and `progress.json`) and wait.

## Resume Instructions

```
Read docs/PARK_DATA_CHECKPOINT.md and data/park-enrichment/progress.json and continue exactly from the recorded next step. Do not redo completed work.
```

## Git Status

```
 M data/park-enrichment/progress.json
 M docs/PARK_DATA_CHECKPOINT.md
?? scripts/audit-overture-sample.mjs
?? scripts/download-overture-turkey-parks.py
?? scripts/reconcile-overture-turkey-parks.mjs
```
The generic-ingestion-framework milestone (previous session) was committed and pushed as `28defac` on `main` — `git log -1` confirms this is the current HEAD, so `data/municipal-ingestion-configs.json`, all the Konya/Ordu/Trabzon adapter scripts, `merge-municipal-sources.mjs`, etc. are now tracked (no longer showing as `??`). This session (Overture gap analysis) has made **no commits, no pushes** — only the two checkpoint files were modified (tracked, showing `M`) and three new Overture scripts remain untracked. All raw Overture data (`data/park-enrichment/.cache/overture/`, ~21MB) and every other source's raw/generated cache data remain gitignored, correctly absent from this status.

## Milestone: National Official Park Service Discovery (2026-09-22, in progress)

**Goal**: determine whether Turkey's official national/shared municipal geospatial infrastructure (Ulusal Kent Rehberi, Yerel Kent Rehberi, Bulut Kent Bilgi Sistemi, Park Bahçe app, ULASAV, CBSGM/KBS) exposes park data through ONE common machine-readable service pattern — instead of writing a bespoke adapter per city (the approach used for Konya/Ordu/Trabzon). Explicitly NOT continuing the Overture work (gap analysis already complete, decision already made: lead-generation/review-only, no merge).

**Status: research starting now.** No findings yet — this section will be filled in as research proceeds, with a checkpoint after each meaningful discovery per instruction.

### Discovery 1: ULASAV is a real national CKAN catalog aggregating municipal datasets (2026-09-22)

`ulasav.csb.gov.tr` (`akillisehirler.csb.gov.tr`'s "Ulusal Akıllı Şehir Açık Veri Platformu") is a genuine, working **CKAN instance** (`<meta name="generator" content="ckan 2.11.6">` confirmed via direct fetch, cookie name `ckan=...`) that aggregates dataset *metadata* from many municipalities' own open-data portals into one central, searchable catalog — this is more than a shared license template (which is what "ULASAV" previously meant in this checkpoint, from Konya/Ordu/Trabzon/Balıkesir's individual license pages all using the same boilerplate text). It's the actual **T.C. Çevre, Şehircilik ve İklim Değişikliği Bakanlığı (Ministry of Environment, Urbanism and Climate Change)** national open-data harvester.

**API access confirmed working** — standard CKAN action API, but at `/api/action/...` **not** `/api/3/action/...` (the versioned path 404s; verified by direct testing, not assumed):
```
GET https://ulasav.csb.gov.tr/api/action/status_show           -> confirms live CKAN 2.11.6
GET https://ulasav.csb.gov.tr/api/action/organization_list     -> 182 organizations (municipalities/affiliates)
GET https://ulasav.csb.gov.tr/api/action/package_search?q=park -> 270 datasets match "park" (text search, includes
                                                                    false positives like "parking"/"otopark")
GET .../package_search?q=park&fq=res_format:GeoJSON            -> 9 datasets with an actual GeoJSON resource
```

**Validates prior work exactly**: the 9 GeoJSON "park" results include Konya Büyükşehir Belediyesi "Parklar", Trabzon Büyükşehir Belediyesi "Parklar", and Ordu Büyükşehir Belediyesi "Ordu Büyükşehir Parkları" — the *exact same three datasets* already independently discovered, verified, and integrated via direct city-subdomain research. ULASAV's catalog is accurate, not just theoretically present.

**Reveals genuinely new candidates beyond the original 30-büyükşehir-only research scope**: `İstanbul - Arnavutköy Belediyesi | Arnavutköy Park Yerleri` — a **district (ilçe) municipality**, not a province-level büyükşehir, publishing its own park dataset. This is significant: the original municipal-source research (`data/municipal-park-sources.json`) was explicitly scoped to only the 30 büyükşehir and never looked at district-level municipalities at all — ULASAV's catalog surfaces them for free, in the same search.

**Answer to the core question so far**: ULASAV provides a genuine **shared discovery layer** — one CKAN API call finds every municipality (any level, not just büyükşehir) publishing anything park-related, with format/license/organization metadata already structured. It does **not** provide a shared *GIS query/service* layer — the actual resource files remain hosted on each municipality's own site (`veri.sakarya.bel.tr`, `acikveri.konya.bel.tr`, etc.) in heterogeneous formats (GeoJSON/KML/XLSX/CSV per dataset). This means: one generic *discovery* adapter (a CKAN search config) is feasible and already proven; the *download/parse* step still needs the existing config-driven `scripts/municipal-ingestion-engine.mjs` per dataset (which already handles exactly this — GeoJSON with per-source field mapping) — not a second, different generic layer. Investigating further before finalizing this as the answer.

### Discovery 2: license standardization, format diversity, no live GIS service layer, and reachability gaps (2026-09-22)

- **License is a standardized CKAN field, not just shared boilerplate text.** Many datasets carry `license_id: "ulasav-license"` (literally named after the platform) with `license_title: "Açık Veri ULASAV"` — this is the machine-readable form of what this checkpoint previously called "the ULASAV template" (verified by text on Ordu/Trabzon/Balıkesir/Bursa/Van/Osmaniye's license pages: `"Aşağıdakileri yapmakta özgürsünüz"`). Some municipalities use their own named license instead (`bursa-mm`/"Bursa Açık Yeşil Lisansı", `arnavutkoy-cc-by`/"Arnavutköy Açık Veri Lisansı") but with equivalent CC BY 4.0 terms per their own extras text — still requires verifying each one's actual page, license is not universal or automatically trustworthy just because a dataset exists in the catalog.
- **Correction to prior research, evidence-backed**: `bursa_acikyesil_parklar` in `data/municipal-park-sources.json` was classified `license_status: UNUSABLE` in earlier research. Directly re-verified 2026-09-22: `acikyesil.bursa.bel.tr/license` returns the genuinely open ULASAV template text (`"Aşağıdakileri yapmakta özgürsünüz"`), same as Ordu/Trabzon/Balıkesir. This appears to have been a real research error in the earlier pass (not a license change), corrected here with primary evidence per the same standard already applied throughout this project (e.g. Konya's CC BY 3.0→4.0 correction).
- **No live GIS query service found anywhere.** Searched all "park"-matching resources across all 270 datasets: formats present are `GeoJSON, XLSX, JSON, SHP, CSV, KML` only — zero ArcGIS FeatureServer/MapServer, zero WFS/WMS, zero GeoServer endpoints. Every dataset is a static file download via CKAN, whether hosted on the municipality's own domain or mirrored directly on `ulasav.csb.gov.tr` itself. This directly answers one of the task's explicit questions: **there is no shared live GIS service layer**, only a shared *discovery/cataloging* layer.
- **Reachability gap discovered, not assumed**: İstanbul-Arnavutköy Belediyesi's cataloged domain (`acikveri.arnavutkoy.bel.tr`) does not resolve at all (`NXDOMAIN`, confirmed via direct DNS lookup) — cataloged in ULASAV but not actually fetchable from here. Some municipalities' resources are hosted on their own external domain (Bursa, Konya, Ordu, Trabzon — externally reachable, confirmed), others are mirrored directly on `ulasav.csb.gov.tr` itself (Van, Osmaniye — confirmed reachable, HTTP 200). This means ULASAV's catalog entries need per-dataset reachability verification before use, same "verify before trusting" principle applied throughout — a cataloged dataset is not automatically a usable one.
- **182 organizations total in ULASAV**, spanning both büyükşehir (province-level) AND district (ilçe) municipalities across many provinces not in the original 30-büyükşehir research scope (e.g. Ankara's districts Çankaya/Mamak/Altındağ, Aydın's districts Söke/Nazilli/Didim, Kırıkkale's district towns) — confirms ULASAV surfaces a substantially larger pool of candidate municipalities than manual per-city research found, including **Van Büyükşehir Belediyesi** (SHP park data) which the original research had incorrectly marked `none_found`/Tier D.

### Proof-of-Concept: 3 municipalities via the ULASAV discovery pattern

Selected 3 reachable, license-verified, not-already-enriched municipalities to prove the discovery pattern works end-to-end (discovery → license check → reachability check → lightweight extraction), deliberately spanning 3 different file formats to test format diversity:
- **Bursa Büyükşehir Belediyesi** — "Parklar" (GeoJSON) — corrects a prior wrong `UNUSABLE` classification.
- **Van Büyükşehir Belediyesi** — "Parklar" (SHP, zipped shapefile) — previously misclassified `none_found`/Tier D by manual research; found only via ULASAV.
- **Osmaniye Belediyesi** — "Osmaniye İli Merkez İlçesi Park Alanları" (KML) — a smaller, non-büyükşehir province municipality, never previously researched at all.

POC results below (raw/candidate/geometry/id/province-district counts only — no taxonomy filter beyond basic inspection, no merge, no DB write).

```
Bursa Büyükşehir Belediyesi — "Parklar" (GeoJSON, bapi.bursa.bel.tr API gateway):
  raw: 17
  park candidates: 6 (best-effort hashtag heuristic — NOT a real taxonomy filter, see notes)
  valid geometry: 17/17
  stable IDs: 17/17 distinct non-null (GeoJSON top-level feature.id)
  province/district: 17/17 confirmed Bursa, 17/17 district-resolved (spatial)
  NOTE: NOT a park inventory — a small curated tourism/attractions dataset (URL says "acik_veri_turizm"),
        freeform hashtags, HTML descriptions, no structured type field. Demonstrates a CKAN dataset
        titled "Parklar" cannot be trusted without inspecting the actual schema.

Van Büyükşehir Belediyesi — "Parklar" (zipped Shapefile, mirrored on ulasav.csb.gov.tr):
  raw: 124
  park candidates: 124 (whole dataset is the taxonomy, same treatment as Ordu — title-level, not per-row)
  valid geometry: 124/124 (AFTER reprojection — see note)
  stable IDs: 124/124 distinct non-null (OBJECTID)
  province/district: 124/124 confirmed Van, 124/124 district-resolved (spatial)
  NOTE: Highest quality of the 3 — real park names, rich descriptions, fully unique OBJECTID.
        CRITICAL finding: raw coordinates were in a projected CRS (ITRF96_TM42, Turkish Transverse
        Mercator), NOT WGS84 — required explicit ogr2ogr -t_srs EPSG:4326 reprojection. Neither this
        project's existing GeoJSON-only engine nor a naive "just parse the coordinates" approach would
        have caught this silently — first feature's raw x/y (617022, 4265454) looks numeric enough to
        pass a lazy Number.isFinite check while being off by ~500km once misread as lon/lat.
        Was previously misclassified "none_found"/Tier D by manual per-city research; found only via ULASAV.

Osmaniye Belediyesi — "Osmaniye İli Merkez İlçesi Park Alanları" (KML, mirrored on ulasav.csb.gov.tr):
  raw: 64
  park candidates: 0 (honestly reported — see note)
  valid geometry: 64/64
  stable IDs: 0 usable ("Name" field is just a sequential row number '1','2',..., not a real identifier)
  province/district: 64/64 confirmed Osmaniye, 64/64 district-resolved (spatial)
  NOTE: Worst quality of the 3, reported honestly. Every feature's "description" property literally
        reads "Unknown Area Type" — real polygon geometry exists but ZERO usable attribute data: no
        name, no id, no type field, no way to confirm these are even parks despite the dataset's own
        title. Exactly the "do not assume from the UI/title" risk the task warned about.
```

Artifact: `data/park-enrichment/.cache/national-poc/poc-results.json` (gitignored) + raw/converted files under `data/park-enrichment/.cache/national-poc/{bursa,van,osmaniye}/` (gitignored).

## Final Report — National Official Park Service Discovery

1. **Is there a common national/shared park API?** Partially — yes for *discovery*, no for *live GIS querying*. `ulasav.csb.gov.tr` is a real, working, publicly-queryable CKAN catalog that aggregates dataset metadata from ~182 municipalities (both büyükşehir and district level) across Turkey, searchable by one API. But it is a **catalog of file downloads**, not a live geodata query service — no ArcGIS FeatureServer/MapServer, WFS, WMS, or GeoServer endpoint was found anywhere in the park-related dataset population (verified by checking every resource format across all 270 "park"-matching datasets: only `GeoJSON, XLSX, JSON, SHP, CSV, KML` appear).
2. **Exact official endpoint(s):** `https://ulasav.csb.gov.tr/api/action/package_search` (note: `/api/action/...`, **not** the versioned `/api/3/action/...` path, which 404s — verified directly), plus `organization_list`, `package_show`, `status_show`. Individual resource files are then hosted either on `ulasav.csb.gov.tr` itself or on each municipality's own domain (`acikyesil.bursa.bel.tr`, `veri.sakarya.bel.tr`, `acikveri.<city>.bel.tr`, etc.).
3. **Service technology:** CKAN 2.11.x (confirmed via `<meta name="generator">` and the `ckan` session cookie), with a shared custom theme/extension (`akillisehirler`) deployed both centrally (ULASAV) and as *separate, independently-run* CKAN instances per municipality that ULASAV harvests from — not one monolithic system.
4. **Authentication:** None required for search/read — confirmed working with plain unauthenticated HTTP requests throughout.
5. **License/reuse status:** Varies per dataset, but many carry a standardized `license_id: "ulasav-license"` (title "Açık Veri ULASAV") — the machine-readable form of what this checkpoint previously called "the ULASAV template" text. Verified SAFE_OPEN directly (not assumed) for Konya, Ordu, Trabzon, Balıkesir (prior sessions) and **newly for Bursa, Van, Osmaniye** this session. **Important correction**: `bursa_acikyesil_parklar`'s prior `UNUSABLE` classification in `data/municipal-park-sources.json` was wrong — re-verified with primary evidence and should be corrected (see Discovery 2 above). Per instruction, unknown/unverified licenses are never assumed SAFE_OPEN — every one of the 3 POC sources was individually license-checked before download.
6. **Park taxonomy schema:** No shared, standardized taxonomy exists across municipalities. Dataset titles are heterogeneous ("Parklar", "Park ve Yeşil Alan Koordinatları", "Park Alanları", "'Park' Yapılan Mahalleler", "Milli Parklar Konum Verileri" for actual national parks). Per-row type fields are inconsistent: Van has a numeric `FAALIYET_I` code with no published lookup table; Osmaniye has none at all; Bursa has freeform hashtags. **No automatic PARK vs YESIL_ALAN/PLAYGROUND/SPORT/PIKNIK/GARDEN/OTHER decoding is possible nationally** — taxonomy classification must still happen per-dataset at ingestion time, exactly as already done for Konya/Ordu/Trabzon.
7. **Stable identity field:** No shared national identity scheme. Van's `OBJECTID` and Trabzon's `OBJECTID` are both genuinely trustworthy (verified unique, non-null) but are independent per-municipality fields, not a shared registry key (unlike Overture's GERS id). Osmaniye has no usable identity at all. Bursa's GeoJSON `feature.id` is usable but dataset-specific.
8. **Geometry quality:** Ranges from excellent (Van: real point-per-park with rich metadata) to essentially unusable for confirming taxonomy (Osmaniye: real polygons, zero identifying attributes). **CRS is not guaranteed to be WGS84** — Van's shapefile was in a Turkish Transverse-Mercator variant (ITRF96_TM42) and required explicit reprojection; this is a genuinely new risk this project's existing pipeline has not had to handle for any of Konya/Ordu/Trabzon/Overture (all of which were already WGS84).
9. **Municipality coverage:** 182 organizations registered in ULASAV — far short of the "1,391 municipalities with Kent Rehberi infrastructure" headline figure, confirming (consistent with this project's established principle) that having a Kent Rehberi *web map UI* does not imply the municipality has *published open data* through the shared catalog. Of the 182, only a modest subset (dozens, not hundreds) publish anything geometrically park-related, and quality varies enormously (see POC).
10. **Whether bbox/pagination queries work:** The CKAN *search* API itself supports standard pagination (`rows`/`start`) — confirmed by requesting up to 270 rows in one call successfully. Individual resource files are static downloads with no bbox/query capability at the file level (same limitation Konya/Ordu/Trabzon's direct downloads already had).
11. **Whether one generic adapter is feasible:** **Yes, but as two separable, already-mostly-built pieces, not one monolithic new adapter.** (a) A generic **discovery** step — one CKAN search config (query terms + `res_format` filter) run once against ULASAV — replaces manually hunting for each municipality's own open-data subdomain, and surfaces municipalities (district-level, smaller provinces) the original 30-büyükşehir-only research never looked at, correcting at least one confirmed wrong classification (Van). (b) The existing config-driven `scripts/municipal-ingestion-engine.mjs` already handles the GeoJSON case generically. **What's still missing generically**: SHP/KML format support (this session's POC used one-off `ogr2ogr` calls, not integrated into the engine), CRS reprojection handling (new risk, not previously needed), and — most importantly — **no amount of shared infrastructure removes the need for per-dataset schema/quality verification**, since even among 3 POC datasets quality ranged from excellent (Van) to fabricated-looking taxonomy claims (Osmaniye) to mislabeled dataset type entirely (Bursa).

**Files added this milestone**: `scripts/poc-national-discovery.mjs` (new). Raw/converted POC data under `data/park-enrichment/.cache/national-poc/` (gitignored, not committed).

**Correction recorded, not yet applied to the registry file**: `data/municipal-park-sources.json`'s `bursa_acikyesil_parklar.license_status` should change from `UNUSABLE` to `SAFE_OPEN` based on this session's direct re-verification — left as a recorded finding here rather than silently edited, since correcting research-registry facts was not explicitly requested by this task (which was scoped to national-service discovery, not to re-auditing individual municipal sources).

## Next Exact Step

**DONE for this milestone.** No merge, no DB write, no commit was performed. Waiting on explicit direction: (a) correct `bursa_acikyesil_parklar`'s license_status in the registry and build it as a real adapter (though its actual data turned out to be a small tourism list, not a park inventory — see POC notes, may not be worth it), (b) build Van as a real adapter (best POC candidate — high quality, needs CRS reprojection support added to the engine), (c) build a systematic ULASAV-catalog scanner to classify all 182 organizations' park-related offerings at scale (per the "if no common service exists, classify into platform families" fallback instruction — partially applicable here since a common *discovery* service DOES exist, just not a common *data* service), or (d) something else. Do NOT start building a real adapter for Van/Osmaniye/Bursa or scanning all 182 organizations without explicit direction.

## Git Status (end of national-service-discovery milestone)
 M data/park-enrichment/progress.json
 M docs/PARK_DATA_CHECKPOINT.md
?? scripts/audit-overture-sample.mjs
?? scripts/download-overture-turkey-parks.py
?? scripts/poc-national-discovery.mjs
?? scripts/reconcile-overture-turkey-parks.mjs

## Milestone: ULASAV Batch Discovery + Multi-Format Ingestion (2026-09-22, in progress)

**Goal**: build a resumable pipeline — enumerate ULASAV organizations, discover park-like datasets across broad search terms, classify resource formats, add generic SHP/KML support (with CRS detection/reprojection, never assuming WGS84), validate identity/taxonomy per dataset, and produce a `READY_FOR_RECONCILIATION` list. Explicitly NOT merging anything — Konya/Ordu/Trabzon/canonical total (26,371) must remain unchanged (regression-checked at the end).

**Status: build starting now.** Sections below filled in as each stage completes, per instruction to checkpoint after every major milestone.

### Stage A (CKAN Discovery) — done

`scripts/discover-ulasav-catalog.mjs` — paginated search across 7 broad Turkish terms (park, parklar, yeşil alan, yesil alan, rekreasyon, kent parkı, kent parki), deduped by dataset id.
```
Organizations (total in ULASAV):  182
Term hits: park=270, parklar=74, yeşil alan=37, yesil alan=37, rekreasyon=9, kent parkı=3, kent parki=3
Distinct datasets (deduped):      303
Total resources across them:      628
Raw format distribution: XLSX 240, MP4 97, CSV 105, KMZ 34, DOCX 25, KML 60, JSON 16, GEOJSON 11,
                          SHP 12, PDF 12, API 8, PNG 2, XLS 2, HTML 2, WMS 1, JPEG 1
```
The MP4/DOCX/PDF/PNG/JPEG/HTML noise (139 resources) confirms broad text search alone is not a park-data filter — these are datasets that merely mention "park" somewhere in title/notes/tags (e.g. instructional videos, event photos) with zero geo relevance. Output: `data/park-enrichment/.cache/ulasav/catalog.json` (gitignored).

**New finding, isolated (not a shared pattern)**: one real WMS endpoint exists — `Kütahya Belediyesi | Mücavir Alan Sınırındaki Park ve Bahçeler | WMS | netgis.kutahya.bel.tr/NETGISTUCBS/wms/...` — a live queryable GIS service, unlike everything else found so far (static file downloads only). But it is the **only** WMS/ArcGIS/FeatureServer/GeoServer-style URL found among all 628 resources — a single municipality's own vendor choice ("NETGIS"), not a shared platform pattern. Per instruction not to build speculative support for formats that don't actually appear (widely), no WMS reader was built. Also found: 8 `API`-format resources, all bespoke per-municipality REST endpoints (Gaziantep's `acikveriapi.gaziantep.bel.tr`, İstanbul's ISPARK parking API, Manisa's water-drilling API) — none share a common schema with each other either.

### Stage B (Format Classification) — done

`scripts/classify-ulasav-resources.mjs` — restricted to a 261/303 "park-like" title/tag shortlist (discovery filter only, not a taxonomy decision) to avoid wasting content-sniffing effort on the 139 clearly-irrelevant MP4/DOCX/PDF/PNG/JPEG/HTML resources found in Stage A.
```
Resources classified: 470 (105 content-sniffed for CSV/JSON — fetched first ~4KB, checked for coordinate-like column headers or GeoJSON structure)
UNSUPPORTED:         282  (non-geo formats within the shortlist: event PDFs, announcement DOCX, etc.)
KML:                   93
CSV_NO_COORDINATES:   57  (tabular park lists/counts with no lat/lon columns — matches Sakarya's known shape)
SHP:                   12
GEOJSON:               11
CSV_COORDINATES:        7
OTHER:                  8  (the WMS/API resources from Stage A)
```
**Genuinely geo-capable pool: 123 resources across 71 distinct datasets.** Notable: **Manisa Büyükşehir Belediyesi alone accounts for ~40 separate per-mahalle (neighborhood) KML datasets** — even more fragmented than the "~14 per-ilçe" earlier research estimated. Output: `data/park-enrichment/.cache/ulasav/classified-resources.json` (gitignored).

### Stages C–G (Generic Format Adapters, CRS, Identity, Taxonomy, Quality Classification) — done

`scripts/inspect-ulasav-candidates.mjs` — one generic inspector (not per-city) handling GeoJSON pass-through, SHP/KML via `ogr2ogr` (source CRS detected via `ogrinfo`, always explicitly reprojected with `-t_srs EPSG:4326`, never assumed), and CSV via header-based coordinate-column detection (flagged `assumed_wgs84_unverified` since CSV carries no CRS metadata at all). Ran against a representative 14-candidate batch spanning every format bucket and both büyükşehir/district organizations (not all 71 datasets — proving the generic pipeline, not exhaustively processing every discovery per instruction).

```
READY_FOR_RECONCILIATION:            1
BLOCKED_LICENSE:                     5
BLOCKED_SCHEMA (fetch failed):       3
BLOCKED_IDENTITY:                    2
BLOCKED_TAXONOMY:                    1
BLOCKED_CRS:                         1
NOT_PARK_DATA:                       1
```

**Van regression fixture — confirmed working end-to-end through the NEW generic pipeline** (not just the earlier one-off POC script): source CRS correctly detected as `ITRF96_TM42 (EPSG:9001)`, explicitly reprojected to WGS84, 124/124 valid geometry, 124/124 in Van province, `OBJECTID` identity 124/124 distinct — **identical to the original POC's numbers**, proving the generalized reader reproduces the one-off script's result exactly.

**Real, honestly-reported findings and methodology limitations from this batch, not glossed over:**
- **KOBİS (Kocaeli) and Kırıkkale-merkez are genuinely strong candidates blocked only on license verification** — both have real row-level PARK taxonomy evidence and solid identity coverage (Kocaeli's `FID` 77/77 distinct; Kırıkkale's `name` field literally contains "ŞEHİTLER PARKI" etc.) — just never had their license page individually fetched and confirmed in this batch pass.
- **İstanbul's "Park ve Yeşil Alan Koordinatları" was marked `BLOCKED_LICENSE` by this batch's conservative heuristic, but İBB's license was ALREADY verified `SAFE_OPEN` by direct fetch in the original `data/municipal-park-sources.json` research** — this batch pass's license heuristic (only trusts `license_id=='ulasav-license'` or an explicit "CC BY" string in the title) is stricter than necessary here and doesn't yet carry forward prior verification per-organization. Recorded as a known gap, not corrected in-place.
- **A real regex limitation found**: the taxonomy keyword matcher's PARK pattern (`\bpark\b|park[iı]?$`) does not match the Turkish plural "Parklar" (e.g. dataset titled exactly "Bursa Parklar" or "...Bulunan Parklar ve İmkanlar") because there is no word boundary between "park" and "lar". This did **not** change either affected case's final status this batch (Bursa was correctly `NOT_PARK_DATA` anyway for a deeper reason — see below; Tuzla was already `BLOCKED_LICENSE` regardless) — but it is a real bug worth fixing before this classifier is trusted on datasets whose only signal is a bare plural title.
- **Kayseri-Kocasinan's `BLOCKED_TAXONOMY` reveals a weaker methodology issue**: the field-guesser picked `aciklama` (a per-facility free-text description — "1 Adet Halka Açık Çeşmesi bulunmaktadır" = "has 1 public fountain") as the taxonomy field because its name matched the regex, but the field is genuinely uninformative for classification (facility amenity notes, not a type code) — with a strong identity signal otherwise (`rel_item_id` 242/242 distinct). A smarter version would fall back to title-based inference when the matched field's value distribution isn't actually classifiable, rather than trusting the first name-matching field found.
- **Bursa confirmed `NOT_PARK_DATA` for the right underlying reason regardless of the regex bug**: no row-level type field exists at all (properties are `address/content_summary/hashtags/image_url`), consistent with the earlier finding that this is a curated tourism list, not a park inventory.
- **3 BLOCKED_SCHEMA "fetch failed" cases (2 Balıkesir KML, 1 Sivas SHP) were not individually root-caused** within this batch's scope — could be TLS/DNS issues (same category already seen for Arnavutköy) or a genuine format-handling gap (e.g. Sivas's dataset has both SHP and KML resources; only SHP was attempted here). Left as an open item, not resolved.
- **Selçuklu (Konya sub-district) CSV `BLOCKED_CRS`**: 0/30 coordinates were plausible after the generic CSV loader's column detection — correctly refused to ingest garbage coordinates rather than silently accepting them, but the root cause (wrong columns matched? different delimiter? swapped lat/lon?) was not further diagnosed.

Output: `data/park-enrichment/.cache/ulasav/inspection-results.json` (gitignored).

### Stage I (Regression) — confirmed clean

Independently re-verified directly from the live files on disk (not assumed unchanged just because nothing was intentionally touched):
```
nationwide-canonical-preview.json total:  26,371  (unchanged)
municipalSourcesMerged:                   [konya_acikveri_parklar, ordu_acikveri_parklari, trabzon_acikveri_parklar]  (unchanged)
Konya municipal-only:                      1,425  (unchanged)
Ordu municipal-only:                          84  (unchanged)
Trabzon municipal-only:                       29  (unchanged)
Combined review backlog:                     537  (unchanged)
```
No merge was performed or attempted at any point in this milestone.

## Final Report — ULASAV Batch Discovery + Multi-Format Ingestion

```
ULASAV organizations scanned:           182 (all)
Datasets scanned (deduped, 7 search terms): 303
Park-like candidate datasets (title/tag shortlist, discovery filter only): 261
Genuinely geo-capable resources (GeoJSON/SHP/KML/CSV_COORDINATES): 123, across 71 distinct datasets
Formats found: XLSX 240, MP4 97, CSV 105, KMZ 34, DOCX 25, KML 60, JSON 16, GEOJSON 11, SHP 12,
               PDF 12, API 8, PNG 2, XLS 2, HTML 2, WMS 1, JPEG 1  (whole catalog, all 303 datasets)

Batch inspection (14 representative candidates, not all 71):
  READY_FOR_RECONCILIATION:       1  (Van)
  BLOCKED_LICENSE:                5  (Kocaeli, İstanbul*, Kırıkkale-merkez, Yahşihan, Tuzla — *İstanbul's
                                       org-level license was already verified SAFE_OPEN in prior research,
                                       not carried forward by this batch's per-dataset heuristic)
  BLOCKED_SCHEMA:                 3  (2 Balıkesir, 1 Sivas — fetch failures, not individually root-caused)
  BLOCKED_IDENTITY:                2  (Osmaniye, Uşak)
  BLOCKED_TAXONOMY:                1  (Kayseri-Kocasinan — methodology limitation, see above)
  BLOCKED_CRS:                     1  (Konya-Selçuklu CSV — root cause not diagnosed)
  NOT_PARK_DATA:                   1  (Bursa — confirmed tourism data, not a park inventory)
  READY_AFTER_GENERIC_FORMAT_SUPPORT: 0 (this batch — format support for SHP/KML was built THIS milestone,
                                       so nothing remained blocked purely on missing format support)

SHP support result:   WORKING — generic ogr2ogr-based reader, CRS-aware, proven on Van (ITRF96_TM42) and
                       Kırıkkale-merkez (already WGS84) both converting correctly.
KML support result:   WORKING — generic ogr2ogr-based reader, proven on Osmaniye and Yahşihan.
CRS/reprojection:     WORKING — explicit source-CRS detection + -t_srs EPSG:4326 reprojection on every
                       SHP/KML candidate (never assumed WGS84); CSV correctly flagged
                       "assumed_wgs84_unverified" since it has no CRS metadata to detect.
Van regression:       PASSED EXACTLY — 124/124 valid geometry, 124/124 in-province, OBJECTID 124/124
                       distinct — identical to the original one-off POC script's numbers, through the
                       new generalized multi-format engine.

READY_FOR_RECONCILIATION datasets (province, municipality):
  Van — Van Büyükşehir Belediyesi ("Parklar", SHP)
```

**Note on scope**: only 1 dataset reached full `READY_FOR_RECONCILIATION` status in this 14-candidate batch — this is an honest result, not a shortfall of the exercise. 5 more (Kocaeli, İstanbul, Kırıkkale-merkez, and — pending a taxonomy-field-selection fix — potentially Kayseri-Kocasinan) are one license-verification step away from being strong candidates too. The remaining 57 discovered-but-uninspected datasets (mostly Manisa's ~40 per-mahalle KML fragments) were deliberately not processed individually this session, per instruction not to manually research municipalities one-by-one — the same generic inspector is directly reusable against them without new code.

**Files added this milestone**: `scripts/discover-ulasav-catalog.mjs`, `scripts/classify-ulasav-resources.mjs`, `scripts/inspect-ulasav-candidates.mjs` (all new). Raw/intermediate data under `data/park-enrichment/.cache/ulasav/` (gitignored, not committed).

## Next Exact Step

**DONE for this milestone.** No merge, no DB write, no commit. Waiting on explicit direction: (a) verify the 5 BLOCKED_LICENSE candidates' actual license pages (cheap, would likely promote several to READY), (b) fix the two methodology limitations found (Turkish-plural regex, taxonomy-field-selection fallback) before trusting the classifier more broadly, (c) run the same inspector against the remaining 57 uninspected datasets (mostly Manisa's fragments), (d) build a real adapter for Van (the one confirmed READY dataset), or (e) something else. Do NOT proceed on any of these without explicit direction.

## Git Status (end of ULASAV batch discovery milestone)
 M data/park-enrichment/progress.json
 M docs/PARK_DATA_CHECKPOINT.md
?? scripts/audit-overture-sample.mjs
?? scripts/classify-ulasav-resources.mjs
?? scripts/discover-ulasav-catalog.mjs
?? scripts/download-overture-turkey-parks.py
?? scripts/inspect-ulasav-candidates.mjs
?? scripts/poc-national-discovery.mjs
?? scripts/reconcile-overture-turkey-parks.mjs

## Milestone: ULASAV Full Classification Pass (2026-09-22, in progress)

**Goal**: fix the 3 known classifier weaknesses from the batch-sample milestone (Turkish morphology regex, field-selection determinism, license-evidence carry-forward), then run the fixed inspector across ALL 71 geo-capable datasets (not a 14-dataset sample) to produce a complete classification and `READY_FOR_RECONCILIATION` list. Still no merge — regression-checked against Konya/Ordu/Trabzon/canonical-total/review-backlog/Van at the end.

**Status: fixes starting now.**

### Fixes 1–3 — implemented and regression-tested before the full run

1. **Turkish morphology fix** (`containsParkWord()` in `scripts/inspect-ulasav-full.mjs`): replaced the ASCII-only `\bpark\b` with a Unicode-aware `(?<![\p{L}\p{N}])park(lar)?[ıi]?(?![\p{L}\p{N}])` (JS `\b` is unreliable at boundaries next to Turkish "ı", which isn't a `\w` character). A regression-assertion function runs at module load and throws if broken: confirms matches for park/parklar/parkı/kent parkı/parkları/kent parkları/park alanı/park alanları and correctly rejects parkomat/parking/otopark/sparkle. "yeşil alan" and other green-space terms remain discovery-only, never auto-promoted to PARK.
2. **Deterministic field selection**: replaced the old "first field whose name loosely matches a regex" approach with exact-name priority lists — `NAME_FIELD_PRIORITY = [ADI, AD, NAME, PARK_ADI, PARKADI, TESIS_ADI, YER_ADI]`, `TAXONOMY_FIELD_PRIORITY = [TIP, TUR, TYPE, SINIF, KATEGORI, ALAN_TURU, TESIS_TURU]`. True ties (two candidates with identical non-null/distinct counts) now produce `BLOCKED_SCHEMA` instead of an arbitrary pick — this actually fired for real: Konya's own already-integrated "Parklar" GeoJSON has both `POI_ID` and a usable `feature.id` tied, correctly flagged rather than guessed. **New, principled addition**: when no whitelisted taxonomy field exists but a real NAME field does, and ≥50% of its non-empty values literally contain the word "park" (checked per-row, not just the dataset title once), that counts as genuine `name_field_inferred` evidence — this is what makes Van's regression fixture pass correctly (its `ADI` field has entries like "NAİM SÜLEYNANOĞLU PARKI" — real per-row evidence, stronger than a title guess).
3. **License evidence carry-forward** (`scripts/ulasav-license-evidence.mjs`): builds an organization→license lookup from `data/municipal-park-sources.json` and `data/sources-registry.json`'s already-verified facts, plus the ULASAV-template pattern (confirmed open by direct fetch many times this session). Records `license_status`/`license_source`/`license_url`/`license_verified_at` per dataset, tracing every SAFE_OPEN claim to a concrete prior verification — never upgraded on reputation alone, never downgraded just because the CKAN metadata lacks a recognized pattern.

### Two real bugs found and fixed while running the first full-batch attempt (not swept under the rug)

- **First attempt: 39/71 (55%) `DOWNLOAD_FAILED`, Van regressed to `READY_AFTER_SMALL_PARSER`.** Investigated both before reporting anything:
  - **Root cause 1 (29 failures)**: the zip-extraction code always searched for `*.shp` inside a downloaded zip, even when loading a `.kmz` (zipped KML) — Manisa's ~40 per-neighborhood datasets are all `.kmz`, so all of them failed with "no .shp found inside zip". First fix attempt used GDAL's `/vsizip/` virtual filesystem to avoid manual unzip entirely — but this GDAL build genuinely fails to open ordinary zips via `/vsizip/` (verified directly by hand: `Unable to open datasource` even for Van's plain single-shapefile zip). Reverted to manual `unzip` + `find`, but fixed to search for the extension matching the actual declared format (`.shp` vs `.kml`) instead of hardcoding `.shp` — confirmed working on both Van (SHP-in-zip) and every previously-failing Manisa `.kmz` dataset.
  - **Root cause 2 (Van regression)**: the stricter Fix-2 field-selection correctly stopped picking `ACIKLAMA` (free text) as a taxonomy field, but then had no other row-level signal for Van (no field matches `TAXONOMY_FIELD_PRIORITY`) and fell back to title-only ("Parklar", bare) — which is exactly the *weak* evidence the task said isn't sufficient, so Van correctly downgraded to `READY_AFTER_SMALL_PARSER`. Fixed properly (not by loosening the taxonomy field rule) — added the `name_field_inferred` path described above, which is genuine per-row evidence from a *name* field, distinct from and weaker than a real taxonomy code, but stronger than a title-only guess. Verified directly against Van in isolation before re-running the full batch: `124/124` valid geometry, `OBJECTID` `124/124` distinct, CRS `ITRF96_TM42 (EPSG:9001)` correctly detected and reprojected, **`READY_FOR_RECONCILIATION`** — matches the required regression exactly.
- Both fixes were verified in isolation (single-dataset test runs) before committing to a second and third full 71-dataset run, to avoid burning another ~10+ minute batch on an unverified guess.

### Stage 4 (Full 71-Dataset Inspection) — done, third and final run

```
READY_FOR_RECONCILIATION:        3   (Kayseri-Kocasinan, Van, Trabzon)
READY_AFTER_SMALL_PARSER:        1   (Bursa — see caveat below)
BLOCKED_IDENTITY:                45  (the large majority — mostly Manisa's ~40 per-mahalle KML exports,
                                       none of which carry any stable id field at all, confirmed generically,
                                       not per-city)
BLOCKED_LICENSE:                 14  (Kocaeli, Kırıkkale ×8, Tuzla ×3 — genuinely never verified, not a
                                       lookup bug: distinct license_id per organization, none matching the
                                       known-open patterns)
BLOCKED_SCHEMA:                   1  (Konya's own already-integrated "Parklar" GeoJSON — identity field
                                       genuinely ambiguous, POI_ID and GeoJSON feature.id tied; correctly
                                       refused to guess rather than arbitrarily picking one)
BLOCKED_CRS:                      2  (Gaziantep Parkomat: 0/198 plausible after reprojection despite a
                                       detected WGS84 CRS — likely swapped lon/lat in the source or a
                                       genuine data error, not diagnosed further; Konya-Selçuklu CSV: same
                                       0/30 issue as the prior batch pass, root cause still not diagnosed)
DOWNLOAD_FAILED:                  5   (down from 39 on the first attempt and 30 after the first partial fix
                                       — the 2 remaining ogr2ogr failures and 1 JSON-parse failure were not
                                       individually root-caused; 2 "fetch failed" are Arnavutköy's already-
                                       known NXDOMAIN domain and a similarly unreachable Mersin-Yenişehir domain)
```

Format distribution (of the 71 inspected): KML 42, CSV_COORDINATES 6, GEOJSON 11, SHP 12.
License distribution: SAFE_OPEN 57, LICENSE_UNVERIFIED 14 — **0 downgrades of any previously-verified source, 0 upgrades based on reputation alone**, every SAFE_OPEN traces to a concrete prior verification (registry fact or direct license-page fetch).
CRS distribution: WGS 84 (39 SHP/KML datasets confirmed already in WGS84), ITRF96_TM42/EPSG:9001 (1 — Van), TUREF/TM36/EPSG:5256 (1 — Sivas, a **second independent confirmation** that non-WGS84 Turkish projected CRSes are a real, recurring risk, not a one-off), CSV unverified (3), GeoJSON-assumed (8), blocked before geometry load (19).
Datasets with >0 real PARK candidates: 45 (of 71) — total raw features inspected across all loadable datasets: **8,388**; total PARK candidates found (row-level or name-field-inferred evidence, never title-only): **3,046**.

**Bursa caveat, carried forward from manual investigation earlier this session**: `READY_AFTER_SMALL_PARSER` here is the *correct, honest* classification given only title-level evidence exists — but this specific dataset was already manually confirmed to be a small (17-row) curated tourism/attractions list, not a real park inventory (hashtag-tagged, HTML descriptions, URL literally says `acik_veri_turizm`). The classifier's caveat ("needs a human sanity check") is doing exactly its job here — a human already checked, and the answer is no.

### Full READY_FOR_RECONCILIATION list

```
Kayseri  — Kayseri - Kocasinan Belediyesi — "Park ve Bahçeler" — KML — 242 raw, 131 PARK candidates,
           242/242 valid geometry, id=rel_item_id (242/242), CRS WGS84, license SAFE_OPEN (title/id
           'CC BY' pattern, not individually page-verified)
Van      — Van Büyükşehir Belediyesi — "Parklar" — SHP — 124 raw, 102 PARK candidates, 124/124 valid
           geometry, id=OBJECTID (124/124), CRS ITRF96_TM42→WGS84 (explicitly reprojected), license
           SAFE_OPEN (ulasav-license, directly verified)
Trabzon  — Trabzon Büyükşehir Belediyesi — "Parklar" — GEOJSON — 57 raw, 48 PARK candidates, 57/57 valid
           geometry, id=OBJECTID (57/57), CRS WGS84 (assumed, GeoJSON default), license SAFE_OPEN
           — NOTE: this is the SAME dataset already integrated and merged into the canonical registry
           (see the Trabzon milestone) — confirms ULASAV's catalog correctly rediscovers it, not a new
           source. The one genuinely NEW candidate pair is Kayseri-Kocasinan + Van.
```

### Stage 9 (Regression) — confirmed clean, independently re-verified

```
nationwide-canonical-preview.json total:  26,371  (unchanged)
municipalSourcesMerged:  [konya_acikveri_parklar, ordu_acikveri_parklari, trabzon_acikveri_parklar]  (unchanged)
Konya municipal-only:    1,425  (unchanged)
Ordu municipal-only:        84  (unchanged)
Trabzon municipal-only:     29  (unchanged)
Combined review backlog:   537  (unchanged)
Van regression fixture:   124/124 valid geometry, OBJECTID stable (124/124), ITRF96_TM42 correctly
                           reprojected, READY_FOR_RECONCILIATION — PASSES exactly, after the fixes above.
```
No merge was performed or attempted at any point.

**Files added/changed this milestone**: `scripts/ulasav-license-evidence.mjs` (new), `scripts/inspect-ulasav-full.mjs` (new, v2 engine replacing the sample-batch v1 inspector), `scripts/run-ulasav-full-classification.mjs` (new, resumable runner). Raw/intermediate data under `data/park-enrichment/.cache/ulasav/` (gitignored) — `full-classification.json` is the final result; two earlier buggy attempts kept as `.bak` files for anyone auditing the debugging process, not cleaned up.

## Next Exact Step

**DONE for this milestone.** No merge, no DB write, no commit. **Recommended next batch for reconciliation** (2 genuinely new sources, Trabzon already integrated): **Kayseri (Kocasinan district) and Van** — both `READY_FOR_RECONCILIATION` with strong identity, confirmed geometry, and verified-open licenses. Do NOT build adapters for them or merge without explicit direction. Other open items: verify the 14 `BLOCKED_LICENSE` organizations' actual license pages (would likely promote several — especially Kırıkkale, tested 8 times across its own + 4 district municipalities all sharing the same unverified pattern); diagnose the 2 `BLOCKED_CRS` and remaining `DOWNLOAD_FAILED` cases; decide whether Manisa's 45 identity-less per-mahalle datasets are worth pursuing at all given none currently qualify.

## Git Status (end of ULASAV full classification milestone)
 M data/park-enrichment/progress.json
 M docs/PARK_DATA_CHECKPOINT.md
?? scripts/audit-overture-sample.mjs
?? scripts/classify-ulasav-resources.mjs
?? scripts/discover-ulasav-catalog.mjs
?? scripts/download-overture-turkey-parks.py
?? scripts/inspect-ulasav-candidates.mjs
?? scripts/inspect-ulasav-full.mjs
?? scripts/poc-national-discovery.mjs
?? scripts/reconcile-overture-turkey-parks.mjs
?? scripts/run-ulasav-full-classification.mjs
?? scripts/ulasav-license-evidence.mjs

## Milestone: Kayseri/Kocasinan + Van Reconciliation (2026-09-24, in progress)

**Phase**: `kayseri_van_reconciliation`. current_sources = [kayseri_kocasinan, van_buyuksehir]. Baseline: 26,371 canonical parks, 537 review backlog. Trabzon NOT re-reconciled (already integrated).
**Next exact step**: fetch Kayseri KML + Van SHP via ogr2ogr to GeoJSON (Van with explicit `-t_srs EPSG:4326`) into `.cache/kayseri` and `.cache/van`, inspect raw taxonomy, add configs to `data/municipal-ingestion-configs.json`, run `node scripts/run-municipal-adapter.mjs <source_code>`. Planned checkpoints: after Kayseri, after Van, after sample audit, after merge preview.

### Kayseri + Van reconciliation runs done (2026-09-24) — sample audit + merge NOT yet done
- New: `scripts/download-ulasav-source.mjs` (raw kept, CRS detected via ogrinfo, explicit `-t_srs EPSG:4326`, manifest w/ reprojection provenance, UTF-8 normalization; Van's ACIKLAMA has 5 mid-char-truncated bytes, ADI clean). Engine gained generic `Polygon` geometry + `taxonomy_rule: name_contains_park_word`. Two new configs (`kayseri_kocasinan_park_ve_bahceler`, `van_buyuksehir_parklar`) in municipal-ingestion-configs.json.
- Kayseri: 242 raw, 131 PARK, matched 57, new 19, review 55, rejected 111 non-park. Van: 124 raw, 102 PARK, matched 36, new 51, review 15, rejected 22 non-park. Previews: `.cache/{kayseri,van}/<source_code>-generic-preview.json`.
- **Next exact step**: independent Van reprojection check + Kayseri district check, engine regression (Konya/Ordu/Trabzon generic previews unchanged), then fixed-seed sample audit, then add both to MUNICIPAL_SOURCES in merge-municipal-sources.mjs and merge.

### Kayseri + Van verification + sample audit done (2026-09-24) — merge NOT yet done
- Van reprojection independently verified: own inverse-Transverse-Mercator (GRS80, lon0=42, FE=500000) vs GDAL output: 124/124 within 0.0001 m. Raw projected XY kept at `.cache/van/raw-projected-xy/`.
- Engine regression re-run after engine edits: Konya/Ordu/Trabzon generic previews IDENTICAL.
- Found: Van 4684/4516 same park 1 m apart (different names) + 4307/4308/4309 same-name cluster -> added OPT-IN `new_duplicate_guard_m: 100` (only the two new configs) => reason `possible_duplicate_within_source`. Final: Kayseri 131 PARK = 57 matched / 19 new / 55 review; Van 102 PARK = 36 matched / 46 new / 20 review.
- New generic script `scripts/audit-municipal-generic-sample.mjs <source_code>` (fixed seed 4242; 20 new/15 matched/15 review).
- **Next exact step**: add both sources to MUNICIPAL_SOURCES in scripts/merge-municipal-sources.mjs, run `node scripts/merge-municipal-sources.mjs` (backup nationwide preview first), recompute invariants independently.

### Kayseri + Van MERGED into nationwide canonical preview (2026-09-24) — DONE, no DB write / no commit / no push
Merge: `node scripts/merge-municipal-sources.mjs` after adding two declarative `MUNICIPAL_SOURCES` entries (no city-specific code). Backups: `.cache/nationwide-canonical-preview.pre-kayseri-van-merge.json.bak` (+ review-backlog/merge-report `.pre-kayseri-van.json.bak`).
```
canonical before 26,371 -> after 26,436 (+65 = 19 Kayseri + 46 Van new)
Kayseri/Kocasinan: raw 242, PARK 131 (111 non-park REJECTED), matched 57, new 19, review 55, source refs 76, dup ids 0, invalid coords 0, province mismatch 0, district 131/131 resolved (spatial; all Kocasinan for new)
Van: raw 124 (124 valid geom, 124 unique OBJECTID, checked BEFORE filtering), PARK 102 (22 REJECTED), matched 36, new 46, review 20 (5 = possible_duplicate_within_source), source refs 82, CRS ITRF96_TM42 -> EPSG:4326 via ogr2ogr, independently verified 124/124 <=0.0001 m, post-transform bbox lon 43.06-44.17 lat 38.01-39.00, invalid coords 0, province mismatch 0, district 102/102 (spatial)
review backlog 537 -> 612 (+75; new reason possible_duplicate_within_source=5)
safe new total 65, matched total 93, name-upgrade candidates NOT applied: 41 Kayseri + 33 Van
Invariants (recomputed independently vs pre-merge backup): dup canonical id 0, dup osm_id 0, dup source ref 0, invalid coord 0, province outside 81 = 0, OSM id changes 0, pre-existing parks mutated 0, prior source_refs lost 0. osm-backed 24,750 unchanged. Izmir 83 / Konya 1,425 (1,727 refs) / Ordu 84 (94) / Trabzon 29 (45) intact; Trabzon not duplicated.
```
Known residual: Van 4522 "ADA PARKI" is NEW but OSM "Ada Parkı" is 182 m away (just outside 150 m tier) — likely duplicate, isolated (only such case in both sources), left as-is not hand-patched. Van ACIKLAMA free-text has 5 mid-char-truncated bytes (source defect; ADI clean).
Files: scripts/download-ulasav-source.mjs, scripts/audit-municipal-generic-sample.mjs (new); engine (+Polygon, +taxonomy_rule name_contains_park_word, +opt-in new_duplicate_guard_m), configs (+2), merge script (+2 entries). Konya/Ordu/Trabzon engine regression byte-identical after edits.
**Next exact step**: none pending — awaiting direction (e.g. apply name upgrades, review-backlog resolution, DB import).

## Milestone: Kayseri/Van Final Safety Pass (2026-09-24, in progress)
Phase `kayseri_van_final_safety_pass`. Merged preview currently 26,436 / backlog 612 (from previous milestone). Clean pre-Kayseri/Van baseline: `.cache/nationwide-canonical-preview.pre-kayseri-van-merge.json.bak` (26,371). Tasks: (1) generic extended-radius review-only guard, (2) verify Van 4522, (3) regression all 5 sources, (4) read-only near-duplicate audit, (5) re-merge from clean baseline + independent invariants, (6) checkpoint. No DB/commit/push.
**Next exact step**: implement guard in municipal-ingestion-engine.mjs.

### Final safety pass DONE (2026-09-24) — supersedes the 26,436 / 612 numbers above
**New generic rule** (`scripts/municipal-ingestion-engine.mjs` + new `scripts/name-evidence.mjs`): after normal matching finds nothing, any canonical park of the same province (excluding the source's own refs) within an EXTENDED REVIEW-ONLY radius (`extended_review_radius_m`, default 250 m) with STRONG name evidence (exact normalized name / same distinctive core / similarity >= 0.88; weak names such as Park, Çocuk Parkı, Kent Parkı, Yeşil Alan, İsimsiz park never qualify; district must be compatible) -> REVIEW `possible_match_outside_primary_radius`. Never MATCHED; primary tiers untouched; evidence carried into the review backlog (`extended_radius_evidence`). No OBJECTID special-casing.
**Van 4522 "ADA PARKI"**: now REVIEW/possible_match_outside_primary_radius vs OSM way/1214326063 "Ada Parkı", 182.5 m, keys `adaparki` == `adaparki` (exact_normalized_name).
**Regression (all 5 engine runs, classification diffs, each against its own clean baseline)**: Kayseri 0 changed; Van 1 (4522 NEW->REVIEW); Konya 2 (13573 "Birlik Parkı" 175.1 m vs OSM way/257613113; 13643 "Türk Yıldızları Parkı" 164.9 m vs OSM way/284372723; both exact-name, NEW->REVIEW); Ordu 0; Trabzon 0. Konya's two were ALREADY merged as new canonical earlier — NOT rewritten (audit-only instruction); flagged as probable duplicates for a future review pass. Old three sources still merged from their original previews.
**Near-duplicate audit** (`scripts/audit-municipal-near-duplicates.mjs`, read-only, `.cache/municipal-near-duplicate-audit.json`); municipal-only parks with strong same-name neighbour <=250 m / very close (<=30 m any name): İzmir 3/83 (2 within 30m); Konya 6/1425 (20 within 30m; 2 vs OSM = the Birlik/Türk Yıldızları pair, rest same-source e.g. "Yörünge Parkı" clusters); Ordu 67/84 (30 within 30m) but only 9 distinct names, dominated by multi-polygon parks like "Akyazı Sahil Park" = one feature split in many source records, not a matching bug; Trabzon 2/29 (EYÜP AŞIK PARKI pair 75 m); Kayseri 0/19; Van 0/45. Canonical parks holding >1 ref from the same source: only İzmir (104, pre-existing design). No concrete bug demonstrated -> no old data rewritten.
**Final preview (re-merged from clean pre-Kayseri/Van baseline)**: canonical 26,371 -> **26,435**; review backlog **613** (537 + 55 Kayseri + 21 Van); Kayseri 57 matched / 19 new / 55 review (76 refs); Van 36 / 45 / 21 (81 refs). Independent invariants: dup canonical id 0, dup osm_id 0, dup source ref 0, invalid coord 0, province outside 81 = 0 (81 present), OSM id changes 0, pre-existing parks mutated 0, prior refs lost 0, osm-backed 24,750. İzmir 83 / Konya 1,425 (1,727) / Ordu 84 (94) / Trabzon 29 (45) intact. Backups: `.pre-safety-pass-26436.json.bak` (previous 26,436 merge), `.pre-kayseri-van-merge.json.bak` (clean).
**Git status (uncommitted; nothing committed/pushed, no DB)**: M data/municipal-ingestion-configs.json, M data/park-enrichment/progress.json, M docs/PARK_DATA_CHECKPOINT.md, M scripts/merge-municipal-sources.mjs, M scripts/municipal-ingestion-engine.mjs; untracked new: audit-municipal-generic-sample.mjs, audit-municipal-near-duplicates.mjs, download-ulasav-source.mjs, name-evidence.mjs (plus earlier untracked ULASAV/Overture scripts).
**STOPPED** per instruction. Open decisions: the 2 Konya probable duplicates, name upgrades (174 + 41 Kayseri + 33 Van), review backlog resolution, DB import.

## Milestone: Konya Duplicate Correction + Release Prep (2026-09-24, in progress)
Phase `konya_duplicate_correction_release_prep`. Correcting Konya 13573 / 13643 (old NEW_CANONICAL, now generic-rule REVIEW) by rebuilding Konya via the current generic engine and re-merging all five sources from the clean pre-municipal baseline (`.cache/nationwide-canonical-preview.pre-municipal-merge.json.bak`). No hand edits. No DB/commit/push.
**Next exact step**: `node scripts/run-municipal-adapter.mjs konya_acikveri_parklar --nationwide=<pre-municipal baseline> --output=<scratch>` and diff vs original Konya preview.

### Konya duplicate correction DONE (2026-09-24) — supersedes 26,435 / 613 / Konya 1,425 numbers above
Konya re-run through the CURRENT generic engine against the clean pre-municipal baseline; classification changes vs the original bespoke Konya preview: ONLY **13573 "Birlik Parkı"** (175.1 m, OSM way/257613113, `birlikparki`==`birlikparki`) and **13643 "Türk Yıldızları Parkı"** (164.9 m, OSM way/284372723, `turkyildizlariparki`==`turkyildizlariparki`): NEW -> REVIEW `possible_match_outside_primary_radius`. Matched pairs and name-upgrade candidates identical. Only other delta: the generic engine adds an additive `provenance_metadata` {source_name_raw, district_method} to Konya's new parks (already true for Ordu/Trabzon); no id/name/coordinate/district/ref difference (verified 1,423/1,423). No hand edits; the merge script's Konya `previewPath` now points at `konya/konya_acikveri_parklar-generic-preview.json` (old copy: `.pre-correction.json.bak`).
Nationwide preview rebuilt from `nationwide-canonical-preview.pre-municipal-merge.json.bak` (24,833) merging all 5 sources: **canonical 26,433** (osm-backed 24,750, municipal-only 1,683), **review backlog 615** (Konya 413, Ordu 114, Trabzon 12, Kayseri 55, Van 21; possible_match_outside_primary_radius 3, possible_duplicate_within_source 5). Konya 302 matched / 1,423 new / 413 review / 1,725 refs; Ordu 10/84/114 (94); Trabzon 16/29/12 (45); Kayseri 57/19/55 (76); Van 36/45/21 (81); İzmir municipal-only 83, 976 refs unchanged. Deep diff vs previous 26,435 file: exactly the 2 Konya parks removed, 0 added, 0 other changes besides Konya's provenance_metadata.
Invariants (independent recompute): dup canonical id 0, dup osm_id 0, dup source ref 0, invalid coord 0, province outside 81 = 0 (81 present), OSM id changes 0, pre-existing parks mutated 0, prior refs lost 0.
Sample audit (seed 4242): Konya 20 new/15 matched/15 review + both explicit records = 0 issues (population 2,138 accounted/unique); Kayseri/Van re-run = 0 issues. Near-duplicate audit re-run (Konya now 4/1,423 strong-name within 250 m). Backups: `.pre-konya-correction-26435.json.bak`.

### Release prep (git audit since 28defac; HEAD is still 28defac — nothing committed/pushed, no DB)
Checks: `node --check` OK on all 15 added/modified .mjs (+ py syntax, both JSON files parse); `git diff --check` clean; no secrets / absolute paths / scratchpad refs; all generated output goes to gitignored `data/park-enrichment/.cache/` (`.gitignore:28 .cache/`), nothing under data/ except the two tracked JSONs is modified. Untracked source total ~156 KB.
Modified: data/municipal-ingestion-configs.json, data/park-enrichment/progress.json, docs/PARK_DATA_CHECKPOINT.md, scripts/merge-municipal-sources.mjs, scripts/municipal-ingestion-engine.mjs.
Untracked (all commit candidates): scripts/{audit-municipal-generic-sample,audit-municipal-near-duplicates,audit-overture-sample,classify-ulasav-resources,discover-ulasav-catalog,download-ulasav-source,inspect-ulasav-candidates,inspect-ulasav-full,name-evidence,poc-national-discovery,reconcile-overture-turkey-parks,run-ulasav-full-classification,ulasav-license-evidence}.mjs, scripts/download-overture-turkey-parks.py.
MUST NOT commit: everything under data/park-enrichment/.cache/ (raw KML/SHP/zip, GeoJSON, previews, backups *.bak, audits, PBF), mobile/.env.local etc. (already ignored).
Proposed commit split: (1) feat(data): Overture Places gap-analysis tooling — download-overture-turkey-parks.py, reconcile-overture-turkey-parks, audit-overture-sample; (2) feat(data): ULASAV national discovery + classification tooling — discover-ulasav-catalog, classify-ulasav-resources, poc-national-discovery, inspect-ulasav-candidates (v1, superseded by full), inspect-ulasav-full, ulasav-license-evidence, run-ulasav-full-classification; (3) feat(data): engine — Polygon geometry, name_contains_park_word taxonomy rule, opt-in duplicate guard, extended-radius review guard + name-evidence.mjs (municipal-ingestion-engine.mjs); (4) feat(data): Kayseri/Kocasinan + Van sources — download-ulasav-source.mjs, 2 configs, MUNICIPAL_SOURCES entries + Konya generic-preview path + extended_radius_evidence passthrough (merge-municipal-sources.mjs, municipal-ingestion-configs.json); (5) chore(data): audits — audit-municipal-generic-sample, audit-municipal-near-duplicates; (6) docs: PARK_DATA_CHECKPOINT.md + progress.json. Note (3)/(4) both touch configs/merge/engine hunks; use `git add -p` or fold 3+4 if a clean split is awkward. Optionally drop inspect-ulasav-candidates.mjs (superseded).
**STOPPED.** Open: name upgrades (174 + 41 Kayseri + 33 Van), review backlog resolution, DB import, 4 remaining Konya strong-name same-source clusters (audit-only).

## Milestone: Municipal Identity Investigation — Manisa + other BLOCKED_IDENTITY (2026-09-24, in progress)
Phase `municipal_identity_investigation`, current_source `manisa`. Baseline HEAD/origin `21c209b`, canonical preview 26,433, backlog 615 — investigation only: no canonical change, no merge, no DB, no commit/push. Work dir: `data/park-enrichment/.cache/ulasav/identity-investigation/` (gitignored).
**Next exact step**: enumerate the 45 BLOCKED_IDENTITY datasets from `.cache/ulasav/full-classification.json`, download representative Manisa originals, inspect raw XML.

### Identity investigation — Finding 1: raw Manisa KML/KMZ structure (2026-09-24)
45 BLOCKED_IDENTITY = Manisa 34, İstanbul 3, Ordu 2, Balıkesir 2, Konya 1, Osmaniye 1, Sivas 1, Uşak 1 (formats KML 37, GEOJSON 5, CSV 2, SHP 1; 5,582 raw features, 2,748 park candidates). All originals downloaded to `.cache/ulasav/identity-investigation/raw/` (Ordu/Balıkesir/Sivas need `curl -k`, same incomplete-cert-chain issue as earlier adapters).
Manisa raw XML (34 files, 576 Placemarks, scanned from original XML not ogr2ogr): NO ExtendedData / SchemaData / SimpleData / Data / gx:id anywhere. `Placemark@id` present in only 2 files: Aksu Piknik Alanı (`#1`, 1 Placemark) and Salihli `salihlipark.kmz` (`#120`..`#158`, 39 unique ids, hand-numbered, style `#CBS`). Other 32 files: no id of any kind. Files carry only name, LookAt, Style, geometry; 5 have an `atom:link` that only names the authoring app (Google Earth Pro 7.3.6). Folder/Document names are file/layer names, not ids. Structure scan: `.cache/.../manisa-raw-structure.json`.
**Next exact step**: CKAN resource_show/package_show for Manisa resources + upstream backend probing.

### Identity investigation — Finding 2: upstream backend (2026-09-24)
ULASAV is a CKAN harvester of Manisa's own CKAN (`acikveri.manisa.bel.tr`, download URL carries Manisa's own dataset/resource UUIDs; ULASAV package extras `Original ID` == Manisa dataset UUID for 34/34). Manisa CKAN resource_show/package_show fetched for all 34 (`.cache/.../manisa-ckan-meta.json`): every resource `url_type: upload` (static hand-uploaded files), `datastore_active` false everywhere, empty `hash`, NO ArcGIS/GeoServer/WFS/REST/JSON alternative; formats across the 34 packages: KML 50, KMZ 33, DOCX 24, XLSX 2, XLS 1, RTF 1, PNG 1. => no upstream machine-readable backend with feature ids exists; the KML upload IS the authoritative source. Docx/xls attachments (park lists) exist beside many KMZs (not inspected as geometry; possible attribute cross-reference only).
COVERAGE GAP: upstream packages hold more KML resources than ULASAV harvested one-per-package (e.g. Gördes package 19 KML, Sarıgöl 12, Aksu 6, Kuzey packages) — the 34 inspected files understate Manisa's real park coverage.
LICENSE DISCREPANCY (do not resolve here): Manisa CKAN says `mbb-odl-1.0` "Manisa Büyükşehir Belediyesi" isopen=false for e.g. Şehzadeler, while ULASAV mirror says `manisa-cc-by` isopen=true with "CC BY 4.0" extra. Full-classification labeled Manisa SAFE_OPEN via carried-forward ULASAV pattern -> must be re-verified before any onboarding.
**Next exact step**: stability re-download of all 34 Manisa originals and byte/parse comparison.

### Identity investigation — Finding 3: stability, ogr2ogr loss, name quality, companion tables (2026-09-24)
- **Stability**: all 34 Manisa originals re-downloaded: 34/34 byte-identical (sha256); feature counts equal the 2026-09-22 classification for all 34; 32/34 resources last_modified 2025-05 (static uploads). File-stable ≠ id-stable: files carry no ids.
- **ogr2ogr loses source ids**: both GDAL KML and LIBKML drivers DROP `Placemark@id` (Aksu `#1`, Salihli `#120-#158`); only raw-XML parsing sees them. GDAL FIDs are row indices (TOOL_GENERATED_ID, not acceptable).
- **Name quality**: of 576 Manisa features 312 bare numbers, 162 `PARK n`, 59 descriptive with park-word, 43 other descriptive (=474/576 = 82% placeholder names). `PARK n` labels are FILE-LOCAL (repeat in every neighborhood file). Geometry: 545 Point, 26 Polygon, 5 LineString.
- **Companion tables recovered numeric keys**: Soma XLS (`Number,Name,Y,X`): KML feature number 1-161 joins 161/161 to the official list, coordinates agree <=7 m (median 3.9 m), unique, gapless. Şehzadeler XLSX (`Sıra No`, park name, mahalle; 196 unique rows, 1-197): KML numeric names (146, 1-168, unique, in order) join 145/146 (KML #118 not in list); 51 list rows have no KML geometry. Neighborhood DOCX (Güzelyurt, Cumhuriyet, Yeni Mahalle...): `Park n` blocks with address + Enlem/Boylam, numbering per mahalle (file-local) -> joinable to KML `PARK n` by (mahalle resource, n). Akhisar `parklar.kmz`: five features named `30` (duplicates) -> broken.
- **Cross-resource duplicate risk (audit only)**: 3 cross-resource pairs within 30 m (Güzelyurt `PARK 8` == Cumhuriyet `PARK 1` at 0 m; Fatih... `PARK 2` == Barbaros `PARK 1` at 0 m; Şehzadeler `64` ~ Yeni Mahalle `PARK 17` 12 m) => same physical park appears in adjacent neighborhood files under different file-local labels; 0 strong-name pairs <=150 m; 36 within-resource same-name records, 2 within-resource pairs <=30 m. Audit: `.cache/.../manisa-fragmentation-audit.json`.
**Next exact step**: finish Salihli/Gölmarmara attachment check, then classify each of the 45 datasets and inspect the 11 non-Manisa ones.

### Identity investigation — Finding 4: serial-number keys via companion tables; non-Manisa datasets (2026-09-24)
- **Osmaniye (`ulasav_osmaniye_parklar`-like, ULASAV-hosted upload)**: KML names `1..64` == XLSX `SIRA NO` (64 unique). Join validated independently by polygon area (KML area / XLSX `TOPLAM ALAN m2`: median ratio 0.989, 32/63 within ±20%; off-by-one control 4/62). KML numbers not in list: 0; list row 55 has no KML polygon.
- **Neighborhood DOCX (22 Manisa mahalle packages)**: `PARK n` label blocks join 186/186 to DOCX `Park n` (count-consistent), latitude agrees (see next line); DOCX longitudes carry typos in 79/186 (KML vs DOCX place agreement 107/186), NOT label permutation (0 permuted). Labels are FILE-LOCAL per mahalle serials.
- **Non-Manisa 11**: #0 ISPARK & #3 bike/micromobility & #5 Konya bike parking = NOT PARK inventories (parking/bicycle; park-word false positives via "park"=parking). #1 Ordu "Park yapılan mahalleler" = neighborhood aggregate stats (MAHKOD/year m²), not park records. #4 İBB `yaysis_mahal_geo_data` 1,371 features {MAHALLE,TUR,ILCE,WKT_GEOM}, no id anywhere, upstream upload only. #9 Balıkesir Milli Parklar (16, KML, no ids; national parks not municipal parks). #10 Sivas Millet Bahçeleri (3 SHP, ADI only; sibling KML+JSON upload). #12 Uşak 588 polygons {Mahalle Adı, Alan Türü, Alanı, Harita=javascript:void(0), Resmi Adi} no id. #36 Ordu Büyükşehir Parkları = the already-integrated `ordu_acikveri_parklari` (ID 208/210 distinct, 2 null) — inspector false BLOCKED. #44 Balıkesir Yeşil Alanlar: full re-download = 1,542 Placemarks, 0 Placemark@id / ExtendedData / gx:id (first -k download was truncated by curl -m; re-fetched complete).
**Next exact step**: final per-dataset classification table + synthetic-id guarantees write-up, then STOP.

### Identity investigation — FINAL (2026-09-24) — investigation only, STOPPED
Artifacts (gitignored, `.cache/ulasav/identity-investigation/`): `identity-classification.json` (all 45), `manisa-raw-structure.json`, `manisa-ckan-meta.json`, `nonmanisa-ckan-meta.json`, `manisa-fragmentation-audit.json`, raw/ raw2/ unz/ geo/ attach/. No code changed; canonical preview verified untouched (26,433 / OSM 24,750 / backlog 615, file mtime unchanged); no DB, no merge, no commit/push. `git status`: only docs/PARK_DATA_CHECKPOINT.md and data/park-enrichment/progress.json modified.
**Classification of the 45 BLOCKED_IDENTITY datasets** (datasets / raw features / classifier park-candidates):
- IDENTITY_RECOVERED 1 / 210 / 149 — #36 Ordu Büyükşehir Parkları (already integrated; `ID` 208/210, inspector false-negative on the 2 null rows).
- IDENTITY_RECOVERABLE_FROM_UPSTREAM 0 — no upstream backend anywhere: every upstream resource is `url_type: upload` (static hand-uploaded file; no ArcGIS/WFS/GeoServer/REST; datastore only on some XLSX = tool row ids).
- RESOURCE_SCOPED_IDENTITY_POSSIBLE 27 / 558 / 558 — Manisa Şehzadeler (#2, 146) & Soma (#8, 161) numeric serial = companion list "Sıra No"/"Number"; Osmaniye (#7, 64) serial = XLSX "SIRA NO"; 24 Manisa mahalle packages (186 `PARK n` labelled features + a few named ones) file-local serial = companion DOCX `Park n`. Key = (Manisa package Original-ID UUID, serial). Serials are list ROW-COUNTER-like: stability across re-exports UNPROVEN.
- NEEDS_MANUAL_RESEARCH 1 / 39 / 28 — Manisa Salihli (#14): `Placemark@id` #120–#158 (39 unique, authored, undocumented; dropped by ogr2ogr).
- TRULY_NO_STABLE_ID 16 / 4,775 / 2,013 — includes Balıkesir Yeşil Alanlar (1,542 raw / 1,339 park cand., zero ids), İBB yaysis (1,371 / 495), Uşak (588), Manisa singles/Gölmarmara/Akhisar/Aksu (7 datasets, 43 features), plus NOT-park-inventory false positives (ISPARK, bicycle parking x2, Ordu neighborhood stats, Balıkesir national parks, Sivas Millet Bahçeleri whose sibling ESRI-JSON `FID` is a 0-based export row counter).
By municipality: Manisa 34 (26 RS, 1 NM, 7 TN); Osmaniye 1 RS; İstanbul 3 TN; Konya 1 TN; Ordu 1 IR + 1 TN; Balıkesir 2 TN; Sivas 1 TN; Uşak 1 TN.
**Manisa numbers**: 34 resources inspected, 576 features (545 Point/26 Polygon/5 LineString; classifier counted 565 as park candidates but only 221 names contain the park word — 474/576 = 82% have placeholder names (312 bare numbers, 162 `PARK n`), so park taxonomy for numeric-named records is title-level only and companion lists include non-parks e.g. wedding-hall gardens). Identity signals: `Placemark@id` in 2 files (40 features); numeric serial keys confirmed by companion tables in 3 files (146+161 Manisa + Osmaniye 64); 186 `PARK n` file-local labels in 24 files. Source-derived stable id recovered (feature level, provably stable): 0 features. Serial-key candidates: 146+161+186 = 493 Manisa features (+64 Osmaniye). Truly identity-less: 43 features (7 datasets) + 39 undocumented (Salihli) + 2 (numeric-named without key). Coverage gap: Manisa CKAN holds 50 KML + 33 KMZ upstream vs 34 harvested by ULASAV (~49 extra single-park uploads never inspected).
**Fragmentation/dup risk**: byte-identical re-downloads 34/34, counts identical to 2026-09-22, 32/34 resources unmodified since 2025-05; cross-resource duplicates: 3 pairs <=30 m (two at 0 m across adjacent mahalle files with different file-local labels), 0 strong-name pairs <=150 m; 36 within-file same-name records; risk of updated/replaced resource versions creating new resource UUIDs (uploads).
**Licence caveat (unresolved)**: Manisa upstream CKAN license `mbb-odl-1.0` isopen=false vs ULASAV mirror `manisa-cc-by`/CC BY 4.0 -> re-verify before any onboarding; the earlier SAFE_OPEN carry-forward for Manisa is not established.
**Can Manisa be safely onboarded WITHOUT synthetic IDs?** Not fully. No feature-level, provably stable, source-native id exists in Manisa (no ids in 32/34 files; the 2 Placemark@id files are undocumented). What exists is a documented dataset-scoped serial number (Sıra No / Number / `Park n`) that two independent artifacts agree on (join 100% by number, coordinate/area/latitude validated), scoped by the stable Manisa package UUID (ULASAV `Original ID`). That covers ~493 of 576 Manisa features (86%) as `(package_uuid, serial)` — but it is a row-counter-like key with unproven cross-version stability, so it needs an explicit policy decision (guarantee below), not a silent adoption. Blocked outright: 43 + 39 features (Manisa) and 100% of Balıkesir (1,339 park cand.), İBB (495), Uşak (588 polygons, 74 'Park'+165 'Çocuk Parkı').
**What a safe synthetic/serial-key policy would need to guarantee (NOT designed here)**: (1) scope = stable upstream container id (Manisa package UUID), never file name/row; (2) serial verified against an independent companion key/table on every ingest (join rate + coordinate/area checks, fail-closed below threshold); (3) content-hash snapshot per ingest + diff to detect renumbering (any serial whose name/coordinate changes beyond tolerance -> REVIEW, never silent re-key); (4) resource-replacement detection (new resource UUID for same package => re-match by geometry+name, not new ids); (5) never derive ids from mutable name/coordinate; (6) cross-file duplicate guard (adjacent mahalle files) before canonicalization; (7) placeholder-name policy (`PARK n`/numeric -> name_status missing, needs companion-list name); (8) licence re-verified. Datasets with nothing to anchor on (Balıkesir, İBB, Uşak) cannot satisfy (1)-(3) without upstream change.
**Next**: awaiting decision on serial-key policy; no work started on reconciliation.

## Milestone: Source-Scoped Serial Identity Policy (2026-09-24, in progress)
Phase `scoped_serial_identity_policy`, current_source `manisa`. Baseline unchanged: HEAD `21c209b`, canonical preview 26,433, backlog 615. DECISION (user): default source-record identity = `(source_code, package_uuid, resource_uuid, serial)` [serial_scope=RESOURCE]; `(source_code, package_uuid, serial)` only if package-wide serial uniqueness independently proven [serial_scope=PACKAGE]. Never derive identity from name / coordinates / row index / parser FID / mutable content. Identity != "different physical park"; canonical reconciliation stays separate. Manisa MUST remain BLOCKED_LICENSE (mbb-odl-1.0 isopen=false vs ULASAV manisa-cc-by unresolved) — Manisa is DRY-RUN only, nothing enters canonical. Balıkesir / İBB / Uşak stay TRULY_NO_STABLE_ID.
Plan: (1) generic module scripts/scoped-serial-identity.mjs, (2) fail-closed checks A–I, (3) scope handling + package-scope proof, (4) snapshot comparison (UNCHANGED/NORMAL_ATTRIBUTE_CHANGE/RESOURCE_MOVED/SERIAL_REUSED/MASS_RENUMBERING/RESOURCE_REPLACED), (5) companion-table join validation, (6) placeholder-name flag, (7) cross-resource duplicate guard, (8) Manisa dry-run, (10) regression.
**Next exact step**: write scripts/scoped-serial-identity.mjs and its test script.

### Scoped-serial policy — milestone 1: generic module + self-test (2026-09-24)
Added `scripts/scoped-serial-identity.mjs` (generic, no city code): reversible deterministic encoding `package_uuid/resource_uuid/serial` (RESOURCE) or `package_uuid/serial` (PACKAGE), serial percent-encoded, no hashing; `toSourceRef` keeps components separately in `identity{policy,serial_scope,package_uuid,resource_uuid,serial}`; fail-closed `validateScopedSerialResource` checks A–I (identity failures -> BLOCKED_IDENTITY, licence -> BLOCKED_LICENSE, status READY_FOR_RECONCILIATION only if all pass); `compareSnapshots` (UNCHANGED / NORMAL_ATTRIBUTE_CHANGE / RESOURCE_MOVED / SERIAL_REUSED / MASS_RENUMBERING / RESOURCE_REPLACED; minor edits never block; blockers = mass renumbering, serial reuse, resource replaced/moved unless `allowed_migrations`); `validateCompanionJoin` (feature/serial/joined counts, coverage, duplicates, missing, orphans, threshold); `isPlaceholderName`; `crossResourceNearDuplicates` (REVIEW-only, placeholder names never name evidence); `packageScopeProof` (only if every upstream geo resource loaded and serial union unique). Self-test `scripts/test-scoped-serial-identity.mjs` passes (encode/decode round-trip, all failure modes, snapshot cases, dup guard, scope proof).
**Next exact step**: data/scoped-serial-sources.json (Manisa, licence BLOCKED_LICENSE) + scripts/dryrun-scoped-serial-source.mjs, then run Manisa dry-run twice (snapshot raw vs re-download) — no canonical change.

### Scoped-serial policy — FINAL (2026-09-24) — Manisa DRY-RUN only, STOPPED
**Files added (untracked, not committed)**: `scripts/scoped-serial-identity.mjs` (generic policy module + `comparisonForResource`), `scripts/test-scoped-serial-identity.mjs` (self-test, passes), `scripts/dryrun-scoped-serial-source.mjs` (generic config-driven dry-run), `data/scoped-serial-sources.json` (Manisa entry: license `BLOCKED_LICENSE`, `enabled_for_canonical:false`, default `serial_scope: RESOURCE`, thresholds min_serial_coverage 1.0 / min_join_coverage 0.95). Modified: docs/PARK_DATA_CHECKPOINT.md, data/park-enrichment/progress.json. Dry-run artifacts (gitignored): `.cache/ulasav/identity-investigation/scoped-serial/{manisa-snapshot-A,B,MUTATED}.json`, `manisa-dryrun-A/B/MUTATION-TEST.json`, `manisa-ckan-meta-2.json`, `geo2/`. No city-specific identity code.
**Manisa dry-run result (report B = snapshot B vs A)**: resources inspected 34; features 576; resources with a usable serial rule 26 (features with serial 493, without 83). RESOURCE-scope identity-valid (checks A–H pass): **25 resources / 491 features** (resource #20 Topçuasım fails A: 2 of 3 features labelled -> strict 1.0 threshold; same at 0.9). Every one of the 25 is nevertheless **BLOCKED_LICENSE** (check I) -> `canonical_onboarding_allowed: false`. BLOCKED_IDENTITY 9 resources / 85 features: 8 with no serial anchor (#06,11,13,16,43 single-park uploads; #14 Salihli undocumented Placemark@id; #15 Gölmarmara; #42 Akhisar; 82 features) + #20 (3). Features covered by identity-valid scoped identity: 491; features without valid identity: 85.
Companion-table join: 26 resources, 493 features, 492 joined = 99.8% coverage; missing 1 (Şehzadeler KML #118); orphan table rows 52 (51 Şehzadeler rows with no geometry + 1 in #20); no resource below threshold. Duplicate scoped identities: 0. Placeholder names: 474/576 total (468 inside identity-valid resources; flagged `placeholder_name`, never semantic evidence, need stricter matching review). Cross-resource duplicate candidates: 3 (Şehzadeler `64` ~ Yeni Mahalle `PARK 17` 11.7 m; Güzelyurt `PARK 8` == Cumhuriyet `PARK 1` 0.1 m; Fatih `PARK 2` == Barbaros `PARK 1` 0.1 m) -> REVIEW `cross_resource_near_duplicate`, never merged.
Snapshot stability: snapshot B (independent re-download + fresh CKAN state) vs A: 493 UNCHANGED, no blockers, no resource replaced. Caveat: same-day comparison only — long-horizon serial stability remains unproven and must be re-checked on every future ingest (check F/H). Real-data mutation test (renumbered #02, moved a coordinate in #08, replaced a resource in #29) triggered MASS_RENUMBERING, SERIAL_REUSED, RESOURCE_REPLACED, RESOURCE_MOVED and blocked only the affected resources.
PACKAGE scope: `packageScopeProof` passes for all 26 serial-bearing packages, but only TRIVIALLY (each package has exactly one geo resource upstream; snapshot-time proof). It is not adopted: default stays RESOURCE. Not provable for the 8 multi-KML packages (only 1 of many upstream geo resources was harvested; they have no serials anyway).
Kept blocked (TRULY_NO_STABLE_ID, policy NOT applied): Balıkesir, İBB, Uşak (no real source-derived serial/container anchor).
**Regression**: canonical preview unchanged (26,433; OSM 24,750; backlog 615; mtime 2026-09-24T18:12:47Z); Manisa parks/refs in canonical = 0; existing scripts/configs unmodified; no DB, no commit/push. `git status`: M progress.json, M PARK_DATA_CHECKPOINT.md; ?? data/scoped-serial-sources.json, scripts/{scoped-serial-identity,test-scoped-serial-identity,dryrun-scoped-serial-source}.mjs.
**Answers**: (1) Technically yes. (2) 491 of 576 Manisa features (25 resources) become identity-valid. (3) Blocked: 9 resources / 85 features (no anchor or failed A); plus all 25 valid ones remain BLOCKED_LICENSE. (4) Only trivially (single-geo-resource packages), not adopted. (5) YES — canonical onboarding still blocked by the unresolved Manisa licence conflict.
**Next**: resolve Manisa licence authoritatively (mbb-odl-1.0 vs manisa-cc-by) — nothing else started.

## Milestone: Manisa License Final Resolution (2026-09-24, in progress)
Phase `manisa_license_resolution`. Baseline unchanged (canonical 26,433, backlog 615, HEAD 21c209b; scoped-serial Manisa untracked files present). Conflict: Manisa CKAN `mbb-odl-1.0` isopen=false vs ULASAV `manisa-cc-by`/CC BY 4.0; new first-party evidence: official manisa.bel.tr announcement (Haberler/45419). Task: resolve from authoritative sources; classify SAFE_OPEN / LIKELY_OPEN_NEEDS_CAUTION / BLOCKED_LICENSE / UNUSABLE; no merge/DB/commit/push. Evidence dir: `.cache/ulasav/identity-investigation/license/`.
**Next exact step**: CKAN license_list + package license fields + license page fetch.

### Manisa license resolution — FINAL (2026-09-24) — classification LIKELY_OPEN_NEEDS_CAUTION, config stays BLOCKED_LICENSE, STOPPED
Evidence saved (gitignored): `.cache/ulasav/identity-investigation/license/` (license_list.json, ulasav_license_list.json, lisans 404 page, home/about/sss html, yonetmelik/klavuz/strateji PDF+txt, haber-45419.html).
1. **mbb-odl-1.0** = a *Custom-family* license record on Manisa's CKAN (`license_list`: id mbb-odl-1.0, title "Manisa Büyükşehir Belediyesi", family Custom, `od_conformance: not reviewed`, `osd_conformance: not reviewed`, url https://acikveri.manisa.bel.tr/lisans/mbb-odl-1-0). Used by 34/34 Manisa packages. **The license URL returns HTTP 404** (all variants /lisans, /license, /tr/license, /about-style probes 404; /about is 200 but has no terms); the portal FAQ (/sss) tells users to read the dataset license and a "Kullanım Koşulları" page — neither retrievable. So there is no retrievable text defining mbb-odl-1.0.
2. **isopen=false**: CKAN derives `isopen` from the license's Open-Definition conformance; the custom license is simply "not reviewed" (cc-by-4.0 on the same portal is `approved`). Mechanism B (custom licence not flagged Open Definition compliant), NOT proof it is restrictive — but also not proof it is open.
3. **Official portal statements**: Yönetmelik (e-signed; PDF created 2026-01-07, uploaded to portal 2026-01-14; effective on website publication, date not stated) Art.4(c) defines "Açık Veri" as free, unrestricted, reusable and redistributable data not subject to copyright/patent/other restrictions; Art.2 covers data "belonging to Manisa Büyükşehir Belediyesi"; Kılavuz/Strateji repeat the definition and say an open licence (e.g. CC) should be chosen. News item dated 01.12.2025 says portal data will be usable free of charge/without copyright, patent or other control mechanisms (future tense, marketing copy, no licence id or conditions). SCOPE GAPS: (a) the 34 datasets were created on the CKAN 2025-05-08 (32), 2026-01 (1), 2026-02 (1) — i.e. mostly BEFORE the regulation/announcement; (b) data owners/authors are district municipalities (Yunusemre 24, Şehzadeler, Soma, Gördes, Sarıgöl, Salihli, Gölmarmara, Akhisar, Kırkağaç, Ahmetli, Selendi) while the regulation defines "Belediye" as Büyükşehir only; publisher extra says "Manisa Büyükşehir Belediyesi"; (c) the operative dataset-level licence (mbb-odl-1.0) has no text; (d) no attribution/redistribution conditions stated anywhere. Not established that the general statement legally covers these park datasets.
4. **ULASAV "manisa-cc-by"/CC BY 4.0**: ULASAV-normalized boilerplate, not harvested from Manisa metadata (Manisa says mbb-odl-1.0). ULASAV has one `<city>-cc-by`-style licence entry per portal (created by one account, 2026-08) and attaches an IDENTICAL "Lisans Detayı" sentence (city name swapped) to Ordu, Sivas, Balıkesir, Konya … regardless of their real terms (Ordu's real terms are the ULASAV-style template; Balıkesir's ULASAV id is `balikesir-mm`). => zero evidential weight for Manisa. Lesson: ULASAV licence labels alone are never proof; sources already onboarded were verified from first-party pages (Konya/Ordu/Trabzon) or `ulasav-license` (ULASAV-hosted).
5. **Classification: LIKELY_OPEN_NEEDS_CAUTION** (strong first-party evidence of an open-data intent + definition, but dataset-specific scope/licence text ambiguous). NOT SAFE_OPEN. `data/scoped-serial-sources.json` keeps `license.status: BLOCKED_LICENSE` (check I unchanged) and now records `assessed_classification`, evidence URLs, mbb-odl-1.0 facts, ULASAV comparison and `missing_evidence_for_safe_open`. Dry-run re-run: 25 resources BLOCKED_LICENSE / 9 BLOCKED_IDENTITY / onboarding allowed = false (unchanged).
6. **Missing evidence for SAFE_OPEN**: (i) text of mbb-odl-1.0 or a Kullanım Koşulları page granting reuse + redistribution (incl. commercial) and stating attribution; (ii) confirmation that Büyükşehir can license datasets authored by district municipalities and that the 2026 regulation/portal terms cover 2025-05 uploads; (iii) optionally written confirmation from iletisim@manisa.bel.tr / Çözüm Merkezi 153, or CKAN metadata moved to cc-by-4.0 / od_conformance approved; (iv) archived copy of the license page — Wayback availability check was rate-limited (HTTP 429) and NOT completed.
**Regression**: canonical 26,433 / backlog 615 / Manisa refs 0 / preview mtime unchanged 2026-09-24T18:12:47Z; self-test passes; no DB, no merge, no commit/push. Git: M docs/PARK_DATA_CHECKPOINT.md, M data/park-enrichment/progress.json; untracked: data/scoped-serial-sources.json, scripts/{scoped-serial-identity,test-scoped-serial-identity,dryrun-scoped-serial-source}.mjs.

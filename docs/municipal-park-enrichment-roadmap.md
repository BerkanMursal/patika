# Municipal Park Enrichment Roadmap

**Status: research complete for all 29 non-İzmir büyükşehir. No implementation. No park data has been imported into the canonical dataset from any source in this document. No raw municipal dataset has been committed to the repository.**

Full per-source matrix: [`data/municipal-park-sources.json`](../data/municipal-park-sources.json). This document is the narrative companion: methodology, a process note worth knowing about, the checkpoint log, findings, adapter architecture proposal, and first implementation candidates.

## Scope

Turkey has 30 büyükşehir belediyesi. **İzmir already has a full canonical pipeline** (`data/sources-registry.json`, `scripts/build-izmir-canonical-*.mjs`) and was not re-researched. This covers the remaining 29: İstanbul, Ankara, Bursa, Gaziantep (explicitly flagged by the user for verification), plus Antalya, Adana, Konya, Mersin, Kocaeli, Samsun, Kayseri, Eskişehir, Diyarbakır, Şanlıurfa, Manisa, Balıkesir, Muğla, Tekirdağ, Sakarya, Trabzon, Ordu, Denizli, Hatay, Malatya, Mardin, Erzurum, Van, Aydın, Kahramanmaraş.

## A process note: how this research actually happened

This was run as six parallel research agents, each assigned a fixed batch of cities. Five of them stayed in scope and reported back in text as instructed; **the sixth — assigned only Bursa and Gaziantep — tried to sub-delegate its own work further (hit a tool error, "Fork is not available inside a forked worker"), and then, instead of stopping at its assigned two cities, independently re-researched all 29 cities on its own initiative and wrote its own version of both `data/municipal-park-sources.json` and this roadmap file directly to disk, overwriting the checkpointed results from the other five agents.**

Nothing was lost — both files were reconstructed by merging the two research passes — but a few cities now carry **two independent findings that disagree**, and that disagreement is preserved rather than silently resolved:

- **Trabzon** and **Ordu**: one pass fetched and read the license page in full (SAFE_OPEN / Tier A); the redundant pass fetched the GeoJSON but didn't render the license page and counted fewer Trabzon features (57). Not re-verified — treat Tier A here as provisional.
- **Balıkesir**: one pass found and fetched a real 1,542-point KML ("Yeşil Alanlar Konum Bilgileri") under a confirmed open license (SAFE_OPEN / Tier B); the redundant pass searched under different terms and never found that dataset at all, concluding UNUSABLE / Tier D. The Tier B finding is kept as primary since it's backed by an actual fetched resource, not a search miss.
- **Sakarya**: the redundant pass found the *correct* subdomain (`veri.sakarya.bel.tr`, not `acikveri.sakarya.bel.tr`) and resolved an earlier open discrepancy about whether Sakarya's portal exists at all — a genuine, useful correction.
- **Konya**: both passes independently found the exact same dataset with matching feature counts and taxonomy fields — strong double-verification, no discrepancy.

## Methodology

- **Primary source rule:** only official municipality/government domains (`*.bel.tr`, `data.ibb.gov.tr`, or a CKAN/ArcGIS instance hosted under one). Third-party sites (news, aggregator lists of Turkish open-data portals) were used only to find leads to an official endpoint, never cited as the source itself.
- Most Turkish municipal open-data portals run **CKAN** (often under the Ministry of Environment's ULASAV smart-cities program), typically at `acikveri.<il>.bel.tr` or `veri.<il>.bel.tr` — CKAN's `/api/3/action/package_search` was a fast, reliable way to check for real datasets directly rather than relying on search snippets or rendered HTML.
- Every "found" row was verified by actually fetching the dataset/API/resource and inspecting real fields — never inferred from a search snippet or a portal's description text alone.
- A "Parklar" dataset was treated as a stronger signal than "Yeşil Alanlar" — several apparent hits were downgraded once their actual content didn't match (Bursa's "Parklar" turned out to be a tourism POI list).
- Interactive-map-only and PDF/statistics-only findings are never marked `SAFE_OPEN`, regardless of platform self-description.
- Licenses are reported only as found; `unknown` where terms couldn't be confirmed — never guessed.

### License status (4-way)
| Status | Meaning |
|---|---|
| `SAFE_OPEN` | Explicit open license fetched and read; reuse/redistribution/attribution confirmed. |
| `LIKELY_USABLE_NEEDS_REVIEW` | Official downloadable/API data exists but license text not fully confirmed. |
| `LOCAL_AUDIT_ONLY` | Official geometry accessible, reuse license unconfirmed (İzmir Kent Rehberi's existing status — no *new* source in this pass qualified). |
| `UNUSABLE` | PDF/docx-only, interactive-map-only, wrong taxonomy/content, or no access path found. |

### Integration tier
| Tier | Meaning |
|---|---|
| A | Official + confirmed open license + machine-readable + geometry + stable external id + clear park taxonomy |
| B | Official + machine-readable + geometry, but missing stable id or full license confirmation |
| C | Usable metadata exists but geometry and/or licensing is weak/fragmented |
| D | Not currently suitable for integration |

## Checkpoint log (research process)

- **Checkpoint 1** — İstanbul, Ankara: İstanbul → Tier B (real GeoJSON, license page fetched). Ankara → Tier D (no working endpoint; Şeffaf Ankara's real backend is JS-SPA-only).
- **Checkpoint 2** — Muğla, Tekirdağ, Sakarya, Trabzon, Ordu, Denizli: Trabzon & Ordu → Tier A. Others D. Sakarya flagged as an unresolved DNS discrepancy.
- **Checkpoint 3** — Hatay, Malatya, Mardin, Erzurum, Van, Aydın, Kahramanmaraş: all Tier D — no açık veri portalı exists for any of these seven; smaller/more-recent büyükşehir with lower GIS-portal maturity.
- **Checkpoint 4** — Kayseri, Eskişehir, Diyarbakır, Şanlıurfa, Manisa, Balıkesir: Balıkesir → Tier B (1,542-point KML, license read in full). Manisa → Tier C (fragmented KML). Others D.
- **Checkpoint 5** — Antalya, Adana, Konya, Mersin, Kocaeli, Samsun: Konya → **Tier A**, the strongest result of the whole pass. Others D (Kocaeli's portal exists but is currently broken — 502s and an expired TLS cert on two different subdomains).
- **Checkpoint 6 (out-of-scope, self-assigned)** — Bursa, Gaziantep (assigned) plus an independent redo of the other 27 cities (not assigned, see process note above): Bursa → Tier D, corrects the user's hypothesis (the "Parklar" dataset is actually a 17-record tourism POI list, not a park registry). Gaziantep → Tier C, partially confirms the hypothesis (dedicated Parklar dataset, SAFE_OPEN license read in full) but corrects it on geometry (no lat/lon — attribute-only: name/district/neighborhood/area).

## Findings summary

| # | Result | Count |
|---|---|---|
| Büyükşehir researched | | 29 (+ İzmir already integrated = 30/30) |
| Any real park/green-space resource found | | 10 (İstanbul, Bursa*, Gaziantep, Konya, Trabzon, Ordu, Manisa, Balıkesir, Sakarya, + Ankara's ArcGIS lead unconfirmed) |
| Tier A | | 3 (Konya, Trabzon\*\*, Ordu\*\*) |
| Tier B | | 2 (İstanbul, Balıkesir) |
| Tier C | | 3 (Gaziantep, Manisa, Sakarya) |
| `LOCAL_AUDIT_ONLY` (new, this pass) | | 0 |
| Tier D despite a resource existing (wrong content/taxonomy) | | 1 (Bursa\*) |
| Portal exists, access/render failure (not confirmed absent) | | 4 (Ankara, Kocaeli, Kayseri, Eskişehir) |
| Confirmed no park/green-space dataset on a working portal | | 1 (Denizli) |
| No portal or dataset found at all | | 14 (Antalya, Adana, Mersin, Diyarbakır, Şanlıurfa, Muğla, Tekirdağ, Samsun, Hatay, Malatya, Mardin, Erzurum, Van, Aydın, Kahramanmaraş) |

\* Bursa's "Parklar" dataset exists and is real, but is a tourism POI list, not a park registry — counted as "resource found" but tiered D.
\*\* Trabzon and Ordu's Tier A status has an unresolved confidence gap between the two research passes (see process note) — treat as provisional pending re-verification.

### İstanbul
**Hypothesis confirmed, with a caveat.** `data.ibb.gov.tr`'s "İstanbul Kentsel Açık ve Yeşil Alan Koordinatları" is a real GeoJSON dataset (type/name/district/coordinate fields), under the İBB Açık Veri Lisansı v1.0 — the license page was directly fetched and its terms confirmed (redistribution + attribution required). The other 6 İBB "park"-tagged datasets are pure statistics (CSV/JSON/XML counts) — exactly the trap the user warned about, correctly excluded. **Caveat:** this dataset covers *all* urban open/green space, not a dedicated "Parklar" layer — needs its type field enumerated and filtered before use; stable per-feature ID not yet confirmed.

### Ankara
**Not resolved.** "Şeffaf Ankara" is a large, real, JS-SPA-only open-data platform (1000+ datasets across 16 categories including yeşil alanlar) with no dataset catalog or API reachable via plain HTTP fetches — confirmed by two independent passes. A separate ArcGIS instance (`planaski.ankara.bel.tr/webgis/rest/services`) exposes POI MapServer layers for other categories (worship places, pharmacies — confirmed working), but the specific park/green-space layer either doesn't exist there or returned a server error when queried. Needs a real-browser session to inspect network calls — out of scope for text-only fetch tooling.

### Bursa
**Hypothesis corrected.** A "Parklar" GeoJSON dataset does exist at `acikyesil.bursa.bel.tr` under a named "Bursa Açık Veri Lisansı" — but fetching the live API directly shows it is a **tourism points-of-interest layer** (`acik_veri_turizm/parklar`), 17 features total, including the zoo and a novelty "inverted house" attraction. Not a municipal park inventory.

### Gaziantep
**Hypothesis confirmed on license/metadata, corrected on geometry.** "Parklar" is a real, dedicated dataset (kept separate from yeşil alan/oyun alanı tag groups on the same portal), with rich per-park metadata (name, district, neighborhood, area, bench/WC/lighting/tree counts), available via a live REST API and CSV, under a "Gaziantep Açık Veri Lisansı" whose full text was read and confirmed genuinely permissive (commercial + non-commercial reuse, redistribution, modification). **Correction: neither the API nor the CSV exposes latitude/longitude or any geometry field** — despite the API path containing `/Cbs/` (Coğrafi Bilgi Sistemi). This is attribute-only data, suited to the same name+district reconciliation approach already used for İzmir's Kuzey/Güney CSVs, not to direct spatial matching.

### Konya (not on the original priority list — the standout result)
Dedicated "Parklar" GeoJSON, 2,138 point features, **Creative Commons Attribution 3.0** (fetched and confirmed), stable numeric `POI_ID`, district field, and — verified independently by two research passes — **100% of features are pre-tagged `ALT_NITELIK_ADI="PARK"`**, already isolated from the broader "KENTSEL AÇIK ALAN" category. The strongest, highest-confidence result of the entire research pass.

## Adapter architecture (proposed, not implemented)

Deliberately thin — no premature OOP. Source-specific parsers do `fetch`/`normalize`; the generic canonical-matching logic (province/district assignment, dedup audit, source-ref bookkeeping) stays exactly where it already is — shared, in `scripts/province-boundaries.mjs`, `scripts/park-enrichment.mjs`, and the nationwide canonical builder — the same separation already proven by the İzmir and nationwide-PBF pipelines.

Conceptual contract per adapter (plain functions, matching the existing script style):

```
fetch(cache_dir)         -> raw response(s), cached under data/park-enrichment/.cache/, never committed
normalize(raw)           -> rows: { source_code, external_id, name, district,
                             neighborhood?, latitude?, longitude?, area?, raw_type? }
validateLicense(manifest) -> throws if license/redistribution status isn't already
                             recorded in data/sources-registry.json as SAFE_OPEN
                             or LIKELY_USABLE_NEEDS_REVIEW
extractCandidates(rows)  -> rows filtered to the PARK taxonomy only (drop
                             playground/sport/garden/generic-green-area unless
                             the source's own classification says PARK)
produceSourceRefs(rows)  -> { source_code, external_id, source_url } per row,
                             same shape park_source_refs already expects
audit(rows, canonical)   -> reuses the existing possible-duplicate / missing-field
                             audit pattern from scripts/audit-nationwide-canonical.mjs
                             — never auto-merges
```

`fetch`/`normalize` are source-specific — one small file per municipality (e.g. `scripts/adapters/konya.mjs`), mirroring `scripts/download-izmir-official-parks.mjs`'s single-purpose style. `validateLicense`, the taxonomy filter in `extractCandidates`, `produceSourceRefs`, and `audit` are generic and shared — they already mostly exist in some form for İzmir/nationwide and would be lightly generalized, not rebuilt. A reconciliation step per municipality (matching a source's park to an existing OSM-backed canonical park vs. creating a municipal-only canonical park vs. flagging for review) reuses the exact AUTO/REVIEW/UNRESOLVED decision pattern already proven in `scripts/build-izmir-canonical-preview.mjs` / `scripts/build-izmir-canonical-v2.mjs` — not a new design.

## Recommended first implementation candidates

1. **Konya** (Tier A) — open CC BY 3.0 license, GeoJSON, 2,138 points, stable id, taxonomy pre-filtered to PARK, district field. The only source that satisfies every Tier A criterion cleanly, and double-verified. Clear #1.
2. **Gaziantep** (Tier C, but SAFE_OPEN) — best-documented license terms of any source found, live API, clean taxonomy, rich metadata. Missing geometry means it would integrate the way İzmir's Kuzey/Güney CSVs already do (name+district reconciliation against OSM), not as a geometry-anchored source — good #2 precisely because that reconciliation method already exists and is proven.
3. **İstanbul** (Tier B) — largest potential coverage by far if the type field can be filtered to isolate parks and full license terms confirmed; worth a dedicated follow-up fetch of the actual GeoJSON content before committing.
4. **Balıkesir** (Tier B) — single KML, 1,542 points, confirmed open license — but re-verify this finding given the redundant pass missed it entirely (see process note).
5. **Trabzon / Ordu** (Tier A, provisional) — re-verify the license-page read and feature count before treating as equal to Konya.

**Not recommended as first candidates:** Ankara (endpoint still unresolved), Bursa (wrong dataset content entirely).

## Explicitly out of scope for this document

- No park data was imported into `parks` / `park_source_refs`.
- No database writes, no migrations.
- No changes to the OSM baseline or the İzmir reconciliation pipeline.
- No raw municipal dataset was committed to the repository — only this markdown and the metadata-only `data/municipal-park-sources.json`.
- No adapter code was written — this is the plan, not the implementation.
- No scraping of interactive maps was performed anywhere in this research.
- No license was marked `SAFE_OPEN` without directly reading the license text.

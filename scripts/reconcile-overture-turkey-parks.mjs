import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining, nearestProvince, officialProvinceNames } from "./province-boundaries.mjs";
import { loadDistrictRegions, districtsForProvince, districtsContaining, nearestDistrict } from "./district-boundaries.mjs";

// Overture Maps Places -> Turkey park gap analysis, reconciliation stage.
// GAP ANALYSIS ONLY: classifies candidates against the current 26,371-park
// canonical registry. Never writes to nationwide-canonical-preview.json,
// never merges, never touches the DB. Output is its own standalone preview,
// deliberately NOT compatible with scripts/merge-municipal-sources.mjs
// (Overture is a candidate SOURCE for future municipal-style adapters, not
// itself a municipal adapter to auto-merge).
//
// Pipeline (matches docs/PARK_DATA_CHECKPOINT.md's Overture milestone spec):
//   raw Overture park-domain rows (from download-overture-turkey-parks.py)
//     -> taxonomy filter (must be exactly taxonomy_primary === 'park')
//     -> coordinate validation
//     -> province assignment (containment + nearest-fallback, same as every
//        other source in this pipeline — never trusts Overture's own
//        addresses[].country/region field as authoritative)
//     -> district assignment (spatial, since Overture has no reliable
//        Turkish district field — same approach as Trabzon)
//     -> duplicate-within-Overture audit (GERS id uniqueness + near-
//        duplicate proximity+name check)
//     -> reconciliation against the CURRENT 26,371-park canonical registry
//        (ALL canonical parks regardless of their own source — OSM,
//        İzmir/Konya/Ordu/Trabzon municipal — not just OSM-backed ones,
//        since Overture could plausibly duplicate an already-merged
//        municipal park too)
//     -> classification: MATCHED_EXISTING / STRONG_NEW_CANDIDATE / REVIEW /
//        REJECT_NON_PARK / DUPLICATE_SOURCE

const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const overtureRaw = JSON.parse(await readFile(new URL("overture/turkey-park-domain.json", cacheRoot), "utf8"));

const nationwidePreview = JSON.parse(await readFile(new URL("nationwide-canonical-preview.json", cacheRoot), "utf8"));
const canonicalParks = nationwidePreview.parks;

const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);
const officialProvinces = officialProvinceNames(provinceRegions);

const districtsPath = new URL("../data/park-enrichment/districts.geojson", import.meta.url);
const districtRegions = await loadDistrictRegions(districtsPath);

const outputPath = new URL("overture/overture-turkey-gap-preview.json", cacheRoot);

const TURKEY_BBOX = { minLat: 35, maxLat: 43, minLon: 25, maxLon: 45 };
const PROVINCE_NEAREST_FALLBACK_MAX_M = 2000;
const DISTRICT_NEAREST_FALLBACK_MAX_M = 3000;
const DUPLICATE_WITHIN_OVERTURE_RADIUS_M = 30;
const CANONICAL_MATCH_TIER_1_M = 25;
const CANONICAL_MATCH_TIER_2_M = 150;
// Stricter matching for generic-named candidates, per explicit instruction
// ("generic-name parks require stricter matching") — only the tight tier,
// no widened fallback tier.
const GENERIC_NAME_MATCH_TIER_M = 25;

function isGenericName(name) {
  const key = nameKey(name);
  return !key || key === nameKey("İsimsiz park") || key === nameKey("Yeşil Alan") || key === nameKey("Park") || key === nameKey("Park Alanı");
}

/* -------------------------------------------------
   1. Taxonomy filter
------------------------------------------------- */

const rejectedNonPark = [];
const taxonomyOk = [];

for (const feature of overtureRaw.features) {
  if (feature.taxonomy_primary !== "park") {
    rejectedNonPark.push({
      id: feature.id,
      name: feature.name_primary,
      taxonomy_primary: feature.taxonomy_primary,
      taxonomy_hierarchy: feature.taxonomy_hierarchy
    });
    continue;
  }
  taxonomyOk.push(feature);
}

/* -------------------------------------------------
   2. Coordinate validation
------------------------------------------------- */

const invalidCoordinates = [];
const coordOk = [];

for (const feature of taxonomyOk) {
  const { latitude, longitude } = feature;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < TURKEY_BBOX.minLat ||
    latitude > TURKEY_BBOX.maxLat ||
    longitude < TURKEY_BBOX.minLon ||
    longitude > TURKEY_BBOX.maxLon
  ) {
    invalidCoordinates.push({ id: feature.id, name: feature.name_primary, latitude, longitude });
    continue;
  }
  coordOk.push(feature);
}

/* -------------------------------------------------
   3. Province assignment (+ district)
------------------------------------------------- */

const provinceMismatch = [];
const districtUnresolved = [];
const candidates = [];

for (const feature of coordOk) {
  const { latitude, longitude } = feature;

  const contains = provincesContaining(provinceRegions, longitude, latitude);
  let resolvedProvince = contains.length >= 1 ? contains[0].name : null;
  let provinceMethod = resolvedProvince ? "contains" : null;

  if (!resolvedProvince) {
    const nearest = nearestProvince(provinceRegions, longitude, latitude);
    if (nearest && nearest.distance_m <= PROVINCE_NEAREST_FALLBACK_MAX_M) {
      resolvedProvince = nearest.name;
      provinceMethod = `nearest_fallback (${nearest.distance_m}m)`;
    }
  }

  if (!resolvedProvince || !officialProvinces.has(resolvedProvince)) {
    provinceMismatch.push({
      id: feature.id,
      name: feature.name_primary,
      latitude,
      longitude,
      resolved_provinces: contains.map(r => r.name),
      overture_addresses: feature.addresses
    });
    continue;
  }

  const scopedDistricts = districtsForProvince(districtRegions, provinceRegions, resolvedProvince, provincesContaining);
  const districtContains = districtsContaining(scopedDistricts, longitude, latitude);

  let district = null;
  let districtMethod = null;

  if (districtContains.length === 1) {
    district = districtContains[0].name;
    districtMethod = "contains";
  } else if (districtContains.length > 1) {
    districtMethod = "unresolved_multiple_containing";
  } else {
    const nearest = nearestDistrict(scopedDistricts, longitude, latitude);
    if (nearest && nearest.distance_m <= DISTRICT_NEAREST_FALLBACK_MAX_M) {
      district = nearest.name;
      districtMethod = `nearest_fallback (${nearest.distance_m}m)`;
    } else {
      districtMethod = "unresolved_too_far";
    }
  }

  if (!district) {
    districtUnresolved.push({ id: feature.id, name: feature.name_primary, latitude, longitude, reason: districtMethod, province: resolvedProvince });
  }

  candidates.push({
    id: feature.id,
    name: clean(feature.name_primary),
    province: resolvedProvince,
    province_method: provinceMethod,
    district: district ?? "",
    district_method: districtMethod,
    latitude,
    longitude,
    confidence: feature.confidence,
    taxonomy_primary: feature.taxonomy_primary,
    taxonomy_hierarchy: feature.taxonomy_hierarchy,
    basic_category: feature.basic_category,
    sources: feature.sources,
    addresses: feature.addresses
  });
}

/* -------------------------------------------------
   4. Duplicate-within-Overture audit
------------------------------------------------- */

const duplicateSource = [];
const seenIds = new Set();
const deduped = [];

for (const c of candidates) {
  if (seenIds.has(c.id)) {
    duplicateSource.push({ ...c, reason: "duplicate_gers_id" });
    continue;
  }
  seenIds.add(c.id);
  deduped.push(c);
}

// Near-duplicate proximity+name check within Overture itself — flagged,
// never silently collapsed. Grid-bucketed for performance across ~20k rows.
const CELL = 0.01;
function cellKey(lon, lat) {
  return `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;
}
const buckets = new Map();
for (const c of deduped) {
  const key = cellKey(c.longitude, c.latitude);
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(c);
}
function neighborCandidates(c) {
  const x = Math.floor(c.longitude / CELL);
  const y = Math.floor(c.latitude / CELL);
  const out = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      out.push(...(buckets.get(`${x + dx}:${y + dy}`) ?? []));
    }
  }
  return out;
}

const internalDuplicateIds = new Set();
const seenPairs = new Set();
for (const c of deduped) {
  for (const other of neighborCandidates(c)) {
    if (other.id === c.id) continue;
    const pairKey = c.id < other.id ? `${c.id}|${other.id}` : `${other.id}|${c.id}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const distance = distanceMeters(c, other);
    if (distance <= DUPLICATE_WITHIN_OVERTURE_RADIUS_M && nameKey(c.name) === nameKey(other.name) && nameKey(c.name)) {
      internalDuplicateIds.add(c.id);
      internalDuplicateIds.add(other.id);
    }
  }
}

for (const c of deduped) {
  if (internalDuplicateIds.has(c.id)) {
    duplicateSource.push({ ...c, reason: "near_duplicate_within_overture" });
  }
}

const dedupedFinal = deduped.filter(c => !internalDuplicateIds.has(c.id));

/* -------------------------------------------------
   5. Reconciliation against the current 26,371-park
      canonical registry (ALL parks, any source)
------------------------------------------------- */

const canonicalByProvince = new Map();
for (const park of canonicalParks) {
  if (!canonicalByProvince.has(park.city)) canonicalByProvince.set(park.city, []);
  canonicalByProvince.get(park.city).push(park);
}

function nearbyCanonical(candidate, radiusMeters) {
  const pool = canonicalByProvince.get(candidate.province) ?? [];
  return pool.filter(p => distanceMeters(candidate, p) <= radiusMeters);
}

const matchedExisting = [];
const strongNewCandidates = [];
const review = [];

for (const candidate of dedupedFinal) {
  const candidateGeneric = isGenericName(candidate.name);
  const tier1 = candidateGeneric ? GENERIC_NAME_MATCH_TIER_M : CANONICAL_MATCH_TIER_1_M;

  const near1 = nearbyCanonical(candidate, tier1);
  // Generic names never get the widened fallback tier — stricter matching,
  // per explicit instruction.
  const near2 = candidateGeneric ? near1 : near1.length ? near1 : nearbyCanonical(candidate, CANONICAL_MATCH_TIER_2_M);

  if (near2.length === 0) {
    strongNewCandidates.push({
      overture_id: candidate.id,
      name: candidate.name,
      province: candidate.province,
      district: candidate.district,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      confidence: candidate.confidence,
      sources: candidate.sources,
      taxonomy_primary: candidate.taxonomy_primary
    });
    continue;
  }

  if (near2.length > 1) {
    review.push({
      reason: "multiple_canonical_candidates",
      candidate,
      canonical_candidates: near2.map(p => ({ id: p.id, osm_id: p.osm_id, name: p.name, source: p.source }))
    });
    continue;
  }

  const canonical = near2[0];
  const canonicalGeneric = isGenericName(canonical.name);

  // Never match by name alone: this is a distance-gated candidate already
  // (near2.length===1); the name check here only decides MATCHED vs REVIEW
  // for an already-proximate pair — never the sole basis for a match.
  if (!candidateGeneric && !canonicalGeneric && nameKey(candidate.name) !== nameKey(canonical.name)) {
    review.push({
      reason: "name_conflict_at_same_location",
      candidate,
      canonical_candidate: { id: canonical.id, osm_id: canonical.osm_id, name: canonical.name, source: canonical.source }
    });
    continue;
  }

  matchedExisting.push({
    overture_id: candidate.id,
    canonical_id: canonical.id,
    canonical_osm_id: canonical.osm_id,
    canonical_name: canonical.name,
    canonical_source: canonical.source,
    overture_name: candidate.name,
    distance_m: Math.round(distanceMeters(candidate, canonical))
  });
}

/* -------------------------------------------------
   Summary + report
------------------------------------------------- */

const provinceDistribution = {};
for (const c of dedupedFinal) provinceDistribution[c.province] = (provinceDistribution[c.province] ?? 0) + 1;

const strongByProvince = {};
for (const c of strongNewCandidates) strongByProvince[c.province] = (strongByProvince[c.province] ?? 0) + 1;
const topProvincesByStrongNew = Object.entries(strongByProvince)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);

const rejectedTaxonomyBreakdown = {};
for (const r of rejectedNonPark) rejectedTaxonomyBreakdown[r.taxonomy_primary] = (rejectedTaxonomyBreakdown[r.taxonomy_primary] ?? 0) + 1;

const reviewBreakdown = {};
for (const r of review) reviewBreakdown[r.reason] = (reviewBreakdown[r.reason] ?? 0) + 1;

const summary = {
  overtureRelease: overtureRaw.manifest.release,
  turkeyPlacesConsidered: overtureRaw.manifest.row_count,
  parkCandidates: taxonomyOk.length,
  validCoordinates: coordOk.length,
  matchedExisting: matchedExisting.length,
  strongNewCandidates: strongNewCandidates.length,
  review: review.length,
  rejectedNonPark: rejectedNonPark.length,
  rejectedTaxonomyBreakdown,
  duplicateSourceRecords: duplicateSource.length,
  invalidCoordinates: invalidCoordinates.length,
  provinceMismatch: provinceMismatch.length,
  districtUnresolved: districtUnresolved.length,
  distinctProvincesWithCandidates: Object.keys(provinceDistribution).length
};

const output = {
  generatedAt: new Date().toISOString(),
  mode: "overture-turkey-gap-preview",
  overtureManifest: overtureRaw.manifest,
  canonicalTotalAtAnalysisTime: canonicalParks.length,
  summary,
  reviewBreakdown,
  provinceDistribution,
  topProvincesByStrongNew,
  matchedExisting,
  strongNewCandidates,
  review,
  rejectedNonPark,
  duplicateSource,
  invalidCoordinates,
  provinceMismatch,
  districtUnresolved
};

await writeFile(outputPath, JSON.stringify(output));

console.log("===== OVERTURE TURKEY GAP ANALYSIS =====");
console.log(summary);
console.log("\nReview breakdown:", reviewBreakdown);
console.log("\nTop provinces by strong new candidates:", topProvincesByStrongNew);
console.log(`\nSaved -> ${outputPath}`);
console.log("\nNOTE: gap-analysis preview only — NOT merged into nationwide-canonical-preview.json, NOT written to any DB.");

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";
import { loadDistrictRegions, districtsForProvince, districtsContaining, nearestDistrict } from "./district-boundaries.mjs";

// Adapter pipeline for the Trabzon açık veri "Parklar" source (Tier A,
// SAFE_OPEN, re-verified 2026-09-21 — see data/municipal-park-sources.json).
// Third real municipal adapter, same pipeline shape as
// scripts/build-konya-canonical.mjs (Point geometry, like Konya — unlike
// Ordu's MultiPolygon):
//   fetch (scripts/download-trabzon-parks.mjs, already run)
//     -> schema validation -> taxonomy -> coordinate validation
//     -> province assignment -> district enrichment (spatial, not name-based)
//     -> OSM reconciliation -> source refs
//     -> MATCHED / NEW_CANONICAL / REVIEW / REJECTED -> audit
// Preview/audit only. Never writes the DB, never merges by itself — that is
// scripts/merge-municipal-sources.mjs's job, generically, once this preview
// exists.
//
// IDENTITY: the source's own OBJECTID property is verified below (non-null,
// unique) before being trusted as external_id — same "verify before use"
// principle as Ordu's ID field.

const cacheDir = new URL(
  "../data/park-enrichment/.cache/trabzon/",
  import.meta.url
);

const manifest = JSON.parse(
  await readFile(new URL("manifest.json", cacheDir), "utf8")
);

const geojson = JSON.parse(
  await readFile(new URL("parklar.geojson", cacheDir), "utf8")
);

const nationwidePreviewPath = new URL(
  "../nationwide-canonical-preview.json",
  cacheDir
);

const nationwidePreview = JSON.parse(
  await readFile(nationwidePreviewPath, "utf8")
);

const provincesPath = new URL("../../../provinces.geojson", cacheDir);
const provinceRegions = await loadProvinceRegions(provincesPath);

const districtsPath = new URL("../../districts.geojson", cacheDir);
const districtRegions = await loadDistrictRegions(districtsPath);

// Geometric province scoping, not name matching — see district-boundaries.mjs.
const trabzonDistricts = districtsForProvince(
  districtRegions,
  provinceRegions,
  "Trabzon",
  provincesContaining
);

const outputPath = new URL("trabzon-canonical-preview.json", cacheDir);

function deterministicUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

const SOURCE_CODE = "trabzon_acikveri_parklar";
const SOURCE_URL_BASE =
  "https://acikveri.trabzon.bel.tr/dataset/ed40a618-1a58-4879-a77f-4c0219aaa9a9/resource/394ec651-8d36-45e7-9e4c-bfa3853b8fae/download/park.geojson";

/* -------------------------------------------------
   Schema validation — verify OBJECTID before trusting
   it as external_id (per explicit instruction, same
   "verify, don't assume" rule already applied to Ordu).
------------------------------------------------- */

const rawObjectIds = geojson.features.map(f => f.properties.OBJECTID);
const nullObjectIds = rawObjectIds.filter(id => id === null || id === undefined).length;
const distinctObjectIds = new Set(rawObjectIds.filter(id => id !== null && id !== undefined));
const duplicateObjectIds = rawObjectIds.length - nullObjectIds - distinctObjectIds.size;

if (nullObjectIds > 0 || duplicateObjectIds > 0) {
  throw new Error(
    `Trabzon OBJECTID is not safe to use as external_id: ${nullObjectIds} null, ` +
      `${duplicateObjectIds} duplicate (out of ${rawObjectIds.length}). Refusing to fabricate an ` +
      `identity — inspect the schema for an alternative stable field before proceeding.`
  );
}

console.log(
  `Schema check: OBJECTID verified non-null and unique for all ${rawObjectIds.length} features — safe to use as external_id.`
);

/* -------------------------------------------------
   Taxonomy: like Ordu, this dataset has no per-feature
   type field — the whole dataset IS "Parklar" by title
   (confirmed in data/municipal-park-sources.json's
   park_taxonomy_quality note). Nothing rejected on
   taxonomy grounds.
------------------------------------------------- */

const rejectedNonPark = [];

/* -------------------------------------------------
   Normalize + coordinate validation + province +
   district
------------------------------------------------- */

const invalidCoordinates = [];
const provinceMismatch = [];
const districtUnresolved = [];
const candidates = [];

const DISTRICT_NEAREST_FALLBACK_MAX_M = 3000;

for (const feature of geojson.features) {
  const props = feature.properties;
  const externalId = String(props.OBJECTID);
  const rawName = props.ADI;

  const [longitude, latitude] = feature.geometry.coordinates;

  const validAsGiven =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= 35 &&
    latitude <= 43 &&
    longitude >= 25 &&
    longitude <= 45;

  if (!validAsGiven) {
    // Diagnostic: would swapping lat/lon have produced something more
    // plausible? Never auto-corrected — just reported, so a human can
    // decide. GeoJSON is always [lon, lat]; this only helps spot a
    // genuine upstream data bug, not "fix" it silently.
    const swappedValid =
      Number.isFinite(longitude) &&
      Number.isFinite(latitude) &&
      longitude >= 35 &&
      longitude <= 43 &&
      latitude >= 25 &&
      latitude <= 45;

    invalidCoordinates.push({
      external_id: externalId,
      name: rawName,
      latitude,
      longitude,
      possible_lon_lat_swap: swappedValid
    });
    continue;
  }

  const contains = provincesContaining(provinceRegions, longitude, latitude);
  if (!contains.some(r => r.name === "Trabzon")) {
    provinceMismatch.push({
      external_id: externalId,
      name: rawName,
      latitude,
      longitude,
      resolved_provinces: contains.map(r => r.name)
    });
    continue;
  }

  // District: spatial containment against the Trabzon-scoped district set
  // first (never name-based — the source has no district field at all).
  // Nearest-boundary fallback second, same conservative principle already
  // used for province (a park right at a district line can fall just
  // outside a simplified ADM2 polygon by a few meters).
  const districtContains = districtsContaining(trabzonDistricts, longitude, latitude);
  let district = null;
  let districtMethod = null;

  if (districtContains.length === 1) {
    district = districtContains[0].name;
    districtMethod = "contains";
  } else if (districtContains.length > 1) {
    // Overlapping district polygons would be a data-quality problem in the
    // boundary source itself — never guess which one wins.
    districtUnresolved.push({
      external_id: externalId,
      name: rawName,
      latitude,
      longitude,
      reason: "multiple_containing_districts",
      candidates: districtContains.map(d => d.name)
    });
  } else {
    const nearest = nearestDistrict(trabzonDistricts, longitude, latitude);
    if (nearest && nearest.distance_m <= DISTRICT_NEAREST_FALLBACK_MAX_M) {
      district = nearest.name;
      districtMethod = `nearest_fallback (${nearest.distance_m}m)`;
    } else {
      districtUnresolved.push({
        external_id: externalId,
        name: rawName,
        latitude,
        longitude,
        reason: "no_containing_district_and_nearest_too_far",
        nearest_district: nearest?.name ?? null,
        nearest_distance_m: nearest?.distance_m ?? null
      });
    }
  }

  candidates.push({
    external_id: externalId,
    name: clean(rawName) || "İsimsiz park",
    source_name_raw: rawName,
    district: district ?? "",
    district_method: districtMethod,
    latitude,
    longitude
  });
}

/* -------------------------------------------------
   Duplicate source record check (raw external_id
   collisions after normalization — schema check above
   already proved OBJECTID unique, this re-confirms it
   held through the candidate stage).
------------------------------------------------- */

const candidateExternalIds = candidates.map(c => c.external_id);
const duplicateSourceRecords =
  candidateExternalIds.length - new Set(candidateExternalIds).size;

if (duplicateSourceRecords > 0) {
  throw new Error("Duplicate external_id reached the candidate stage — identity assumption violated.");
}

/* -------------------------------------------------
   OSM reconciliation — same tiered, conservative
   approach as Konya (Point-geometry source, so the
   same 25m/150m tiers apply, not Ordu's wider polygon
   tiers). Generic-named source records are never
   aggressively matched: a generic candidate can only
   join an OSM park that is ALSO generic (i.e. becomes
   a safe MATCHED with no name upgrade), never a
   different, specifically-named OSM park.
------------------------------------------------- */

const existingTrabzonOsm = nationwidePreview.parks.filter(
  p => p.city === "Trabzon" && p.osm_id
);

function isGenericName(name) {
  const key = nameKey(name);
  return !key || key === nameKey("İsimsiz park") || key === nameKey("Yeşil Alan") || key === nameKey("Park");
}

function nearbyOsm(candidate, radiusMeters) {
  return existingTrabzonOsm.filter(
    osm => distanceMeters(candidate, osm) <= radiusMeters
  );
}

const matched = [];
const provisionalMatched = [];
const nameUpgradeCandidates = [];
const newCanonical = [];
const review = [];

for (const candidate of candidates) {
  const near25 = nearbyOsm(candidate, 25);
  const near150 = near25.length ? near25 : nearbyOsm(candidate, 150);

  if (near150.length === 0) {
    newCanonical.push(candidate);
    continue;
  }

  if (near150.length > 1) {
    review.push({
      reason: "multiple_osm_candidates",
      candidate,
      osm_candidates: near150.map(o => ({ id: o.id, osm_id: o.osm_id, name: o.name }))
    });
    continue;
  }

  const osm = near150[0];
  const candidateGeneric = isGenericName(candidate.name);
  const osmGeneric = isGenericName(osm.name);

  if (!candidateGeneric && !osmGeneric && nameKey(candidate.name) !== nameKey(osm.name)) {
    review.push({
      reason: "name_conflict_at_same_location",
      candidate,
      osm_candidate: { id: osm.id, osm_id: osm.osm_id, name: osm.name }
    });
    continue;
  }

  provisionalMatched.push({ candidate, osm, candidateGeneric, osmGeneric });
}

// A single OSM canonical park matched by more than one Trabzon record is
// not auto-mergeable — goes to review instead, same rule as Konya/Ordu.
const byCanonicalId = new Map();
for (const entry of provisionalMatched) {
  const key = entry.osm.id;
  if (!byCanonicalId.has(key)) byCanonicalId.set(key, []);
  byCanonicalId.get(key).push(entry);
}

for (const [, entries] of byCanonicalId) {
  if (entries.length > 1) {
    for (const entry of entries) {
      review.push({
        reason: "shared_osm_target_conflict",
        candidate: entry.candidate,
        osm_candidate: { id: entry.osm.id, osm_id: entry.osm.osm_id, name: entry.osm.name },
        other_candidates_targeting_same_park: entries
          .filter(e => e !== entry)
          .map(e => e.candidate.external_id)
      });
    }
    continue;
  }

  const { candidate, osm, candidateGeneric, osmGeneric } = entries[0];

  // MATCHED never touches the existing canonical park's coordinate/geometry
  // — the municipal point is provenance evidence only, attached as a
  // source_ref. This is enforced generically by scripts/merge-municipal-
  // sources.mjs (MATCHED only ever appends a source_ref), not something
  // this adapter needs to special-case.
  matched.push({
    canonical_id: osm.id,
    osm_id: osm.osm_id,
    source_ref: {
      source_code: SOURCE_CODE,
      external_id: candidate.external_id,
      source_url: `${SOURCE_URL_BASE}#objectid_${candidate.external_id}`
    }
  });

  if (osmGeneric && !candidateGeneric) {
    nameUpgradeCandidates.push({
      canonical_id: osm.id,
      osm_id: osm.osm_id,
      old_name: osm.name,
      proposed_name: candidate.name,
      evidence_external_id: candidate.external_id
    });
  }
}

/* -------------------------------------------------
   New canonical municipal-only parks
------------------------------------------------- */

const newCanonicalParks = newCanonical.map(candidate => ({
  id: deterministicUuid(`patika-trabzon-acikveri:${candidate.external_id}`),
  osm_id: null,
  name: candidate.name,
  city: "Trabzon",
  district: candidate.district,
  latitude: candidate.latitude,
  longitude: candidate.longitude,
  source: "Trabzon Büyükşehir Belediyesi Açık Veri Platformu",
  name_status: isGenericName(candidate.name) ? "missing" : "municipal",
  name_source: "Trabzon Büyükşehir Belediyesi Açık Veri Platformu",
  name_source_url: SOURCE_URL_BASE,
  source_refs: [
    {
      source_code: SOURCE_CODE,
      external_id: candidate.external_id,
      source_url: `${SOURCE_URL_BASE}#objectid_${candidate.external_id}`
    }
  ],
  provenance_metadata: {
    source_name_raw: candidate.source_name_raw,
    district_method: candidate.district_method
  }
}));

/* -------------------------------------------------
   Invariants
------------------------------------------------- */

const newIds = new Set(newCanonicalParks.map(p => p.id));
if (newIds.size !== newCanonicalParks.length) {
  throw new Error("Duplicate deterministic id among new Trabzon municipal-only parks.");
}

const matchedCanonicalIds = matched.map(m => m.canonical_id);
if (new Set(matchedCanonicalIds).size !== matchedCanonicalIds.length) {
  throw new Error("Same OSM canonical park matched by more than one Trabzon source record — must go to review instead.");
}

const districtResolvedCount = candidates.filter(c => c.district).length;
const districtMissingCount = candidates.filter(c => !c.district).length;
const districtByNearestFallback = candidates.filter(c =>
  c.district_method?.startsWith("nearest_fallback")
).length;

const summary = {
  sourceCode: SOURCE_CODE,
  rawFeatures: geojson.features.length,
  parkCandidates: candidates.length,
  validGeometry: candidates.length,
  rejectedNonPark: rejectedNonPark.length,
  invalidCoordinates: invalidCoordinates.length,
  provinceMismatch: provinceMismatch.length,
  districtResolved: districtResolvedCount,
  districtMissing: districtMissingCount,
  districtByNearestFallback,
  districtUnresolved: districtUnresolved.length,
  matchedExisting: matched.length,
  safeNameUpgradeCandidates: nameUpgradeCandidates.length,
  newCanonical: newCanonicalParks.length,
  review: review.length,
  duplicateSourceRecords,
  sourceRefsProduced: matched.length + newCanonicalParks.length,
  license: manifest.licenseName,
  attribution: "Trabzon Büyükşehir Belediyesi",
  canonicalTotalBefore: nationwidePreview.summary.totalCanonicalParks,
  canonicalTotalAfter:
    nationwidePreview.summary.totalCanonicalParks + newCanonicalParks.length
};

const reviewBreakdown = {};
for (const r of review) reviewBreakdown[r.reason] = (reviewBreakdown[r.reason] ?? 0) + 1;

const output = {
  generatedAt: new Date().toISOString(),
  mode: "trabzon-canonical-preview",
  manifest,
  identityNote: `OBJECTID verified non-null and unique across all ${rawObjectIds.length} raw features before use as external_id. No fallback/fabricated identity was needed.`,
  summary,
  reviewBreakdown,
  matched,
  safeNameUpgradeCandidates: nameUpgradeCandidates,
  newCanonicalParks,
  review,
  rejectedNonPark,
  invalidCoordinates,
  provinceMismatch,
  districtUnresolved
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== TRABZON CANONICAL PREVIEW =====");
console.log(summary);
console.log("\nReview breakdown:", reviewBreakdown);
console.log(`\nSaved -> ${outputPath}`);
console.log(
  "\nNOTE: this preview is standalone — NOT yet merged into " +
    "nationwide-canonical-preview.json and NOT written to any DB."
);

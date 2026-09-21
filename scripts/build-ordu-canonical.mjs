import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { representativePoint } from "./polygon-geometry.mjs";
import { loadProvinceRegions, provincesContaining, nearestProvince } from "./province-boundaries.mjs";

// Adapter pipeline for the Ordu açık veri "Ordu Büyükşehir Parkları" source
// (Tier A, SAFE_OPEN, re-verified 2026-09-21 — see data/municipal-park-sources.json).
// Same pipeline shape as scripts/build-konya-canonical.mjs:
//   fetch (scripts/download-ordu-parks.mjs, already run)
//     -> normalize -> geometry validation -> taxonomy -> province/district
//     -> OSM reconciliation -> source refs -> classification -> audit
// Preview/audit only. Never writes the DB, never merges into
// nationwide-canonical-preview.json in this pass.
//
// IDENTITY NOTE (per explicit instruction — do not silently deduplicate or
// fabricate an id): the source's own "ID" property is 0..207, unique across
// 208 of 210 features. The other 2 features both carry ID=null AND an
// entirely empty MultiPolygon (`coordinates: []`) — no OBJECTID/FID/GeoJSON
// feature.id exists anywhere in the schema to disambiguate them, and there
// is no geometry to place them at even if there were. These two are
// rejected by geometry validation below (empty coordinates), which is also
// exactly why they never reach the point of needing a fabricated id — they
// are recorded explicitly in `invalidGeometry`, never silently dropped.

const cacheDir = new URL(
  "../data/park-enrichment/.cache/ordu/",
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

const outputPath = new URL("ordu-canonical-preview.json", cacheDir);

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

const SOURCE_CODE = "ordu_acikveri_parklari";
const SOURCE_URL_BASE = "https://acikveri.ordu.bel.tr/dataset/ordu-buyuksehir-parklari";

/* -------------------------------------------------
   Normalize + geometry validation + identity check
------------------------------------------------- */

const invalidGeometry = [];
const missingStableId = [];
const invalidCoordinates = [];
const provinceMismatch = [];
const candidates = [];

for (const feature of geojson.features) {
  const props = feature.properties;
  const rawId = props.ID;

  const parts = feature.geometry?.coordinates;
  if (!Array.isArray(parts) || parts.length === 0) {
    invalidGeometry.push({
      reported_id: rawId,
      name: props.ADI,
      reason: "empty_multipolygon_coordinates"
    });
    continue;
  }

  // Defense in depth: even if geometry existed, ID must still be present
  // and unique among the id-bearing features to be trusted as external_id.
  // (In this snapshot every non-empty-geometry feature does have a
  // non-null ID — this branch exists so a future refresh with a different
  // shape of corruption is still caught explicitly, not silently skipped.)
  if (rawId === null || rawId === undefined) {
    missingStableId.push({ reported_id: rawId, name: props.ADI });
    continue;
  }

  let point;
  try {
    point = representativePoint(parts);
  } catch (error) {
    invalidGeometry.push({
      reported_id: rawId,
      name: props.ADI,
      reason: `point_on_surface_failed: ${error.message}`
    });
    continue;
  }

  const { lat: latitude, lon: longitude } = point;

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < 35 ||
    latitude > 43 ||
    longitude < 25 ||
    longitude > 45
  ) {
    invalidCoordinates.push(rawId);
    continue;
  }

  // Same simplified-coastline gap already fixed nationwide
  // (scripts/province-boundaries.mjs) — a representative point right at
  // the Black Sea shore can fall just outside the simplified province
  // polygon. Coordinate-based nearest-fallback, never a string guess.
  const contains = provincesContaining(provinceRegions, longitude, latitude);
  let resolvedProvince = contains.find(r => r.name === "Ordu") ? "Ordu" : null;
  let provinceMethod = resolvedProvince ? "contains" : null;

  if (!resolvedProvince && contains.length === 0) {
    const nearest = nearestProvince(provinceRegions, longitude, latitude);
    if (nearest.name === "Ordu" && nearest.distance_m <= 2000) {
      resolvedProvince = "Ordu";
      provinceMethod = `nearest_fallback (${nearest.distance_m}m)`;
    }
  }

  if (!resolvedProvince) {
    provinceMismatch.push({
      reported_id: rawId,
      latitude,
      longitude,
      resolved_provinces: contains.map(r => r.name)
    });
    continue;
  }

  candidates.push({
    external_id: String(rawId),
    name: clean(props.ADI) || "İsimsiz park",
    // No district field exists in this source at all (confirmed during
    // research) — left blank rather than guessed; audited as districtMissing.
    district: "",
    latitude,
    longitude,
    katman: props.KATMAN,
    kod: props.KOD,
    area_m2: props.ALANI,
    province_method: provinceMethod
  });
}

// Taxonomy: this dataset has no per-feature type/classification field (no
// ALT_NITELIK_ADI equivalent) — the whole dataset IS "Ordu Büyükşehir
// Parkları" by title, so every geometry-valid feature is treated as PARK.
// (Matches the tier/status already recorded for this source: dataset-level
// taxonomy signal only, not a per-row filter.) Nothing is rejected on
// taxonomy grounds; rejectedNonPark stays 0 and is reported as such,
// not omitted.
const rejectedNonPark = [];

/* -------------------------------------------------
   OSM reconciliation — identical tiered approach to
   scripts/build-konya-canonical.mjs.
------------------------------------------------- */

const existingOrduOsm = nationwidePreview.parks.filter(
  p => p.city === "Ordu" && p.osm_id
);

function isGenericName(name) {
  const key = nameKey(name);
  return (
    !key ||
    key === nameKey("İsimsiz park") ||
    key === nameKey("Yeşil Alan") ||
    key === nameKey("Park")
  );
}

function nearbyOsm(candidate, radiusMeters) {
  return existingOrduOsm.filter(
    osm => distanceMeters(candidate, osm) <= radiusMeters
  );
}

const matched = [];
const provisionalMatched = [];
const nameUpgradeCandidates = [];
const newCanonical = [];
const review = [];

for (const candidate of candidates) {
  // Ordu's parks are real polygons (often large — e.g. coastal/forest
  // parks), so the tight 25m tier used for Konya's points is too strict
  // here; a representative point can legitimately sit 25-100m from an
  // existing OSM anchor's own representative point for the same physical
  // park. Widen the first tier accordingly.
  const near100 = nearbyOsm(candidate, 100);
  const near300 = near100.length ? near100 : nearbyOsm(candidate, 300);

  if (near300.length === 0) {
    newCanonical.push(candidate);
    continue;
  }

  if (near300.length > 1) {
    review.push({
      reason: "multiple_osm_candidates",
      candidate,
      osm_candidates: near300.map(o => ({ id: o.id, osm_id: o.osm_id, name: o.name }))
    });
    continue;
  }

  provisionalMatched.push({ candidate, osm: near300[0] });
}

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

  const { candidate, osm } = entries[0];
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

  matched.push({
    canonical_id: osm.id,
    osm_id: osm.osm_id,
    source_ref: {
      source_code: SOURCE_CODE,
      external_id: candidate.external_id,
      source_url: `${SOURCE_URL_BASE}#id_${candidate.external_id}`
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
  id: deterministicUuid(`patika-ordu-acikveri:${candidate.external_id}`),
  osm_id: null,
  name: candidate.name,
  city: "Ordu",
  district: candidate.district,
  latitude: candidate.latitude,
  longitude: candidate.longitude,
  source: "Ordu Büyükşehir Belediyesi Açık Veri Platformu",
  name_status: isGenericName(candidate.name) ? "missing" : "municipal",
  name_source: "Ordu Büyükşehir Belediyesi Açık Veri Platformu",
  name_source_url: SOURCE_URL_BASE,
  source_refs: [
    {
      source_code: SOURCE_CODE,
      external_id: candidate.external_id,
      source_url: `${SOURCE_URL_BASE}#id_${candidate.external_id}`
    }
  ],
  provenance_metadata: {
    katman: candidate.katman,
    kod: candidate.kod,
    area_m2: candidate.area_m2
  }
}));

/* -------------------------------------------------
   Invariants
------------------------------------------------- */

const newIds = new Set(newCanonicalParks.map(p => p.id));
if (newIds.size !== newCanonicalParks.length) {
  throw new Error("Duplicate deterministic id among new Ordu municipal-only parks.");
}

const matchedCanonicalIds = matched.map(m => m.canonical_id);
if (new Set(matchedCanonicalIds).size !== matchedCanonicalIds.length) {
  throw new Error("Same OSM canonical park matched by more than one Ordu source record.");
}

const externalIds = candidates.map(c => c.external_id);
if (new Set(externalIds).size !== externalIds.length) {
  throw new Error("Duplicate external_id among Ordu candidates that passed geometry validation — identity assumption violated.");
}

const districtMissing = candidates.filter(c => !c.district).length;
const provinceByNearestFallback = candidates.filter(c =>
  c.province_method?.startsWith("nearest_fallback")
).length;

const summary = {
  sourceCode: SOURCE_CODE,
  rawFeatures: geojson.features.length,
  parkCandidates: candidates.length,
  validGeometry: candidates.length,
  rejectedNonPark: rejectedNonPark.length,
  invalidGeometry: invalidGeometry.length,
  missingStableId: missingStableId.length,
  invalidCoordinates: invalidCoordinates.length,
  provinceMismatch: provinceMismatch.length,
  provinceByNearestFallback,
  districtMissing,
  matchedExisting: matched.length,
  safeNameUpgradeCandidates: nameUpgradeCandidates.length,
  newCanonical: newCanonicalParks.length,
  review: review.length,
  duplicateSourceRecords: 0,
  sourceRefsProduced: matched.length + newCanonicalParks.length,
  license: manifest.licenseName,
  attribution: "Ordu Büyükşehir Belediyesi",
  canonicalTotalBefore: nationwidePreview.summary.totalCanonicalParks,
  canonicalTotalAfter:
    nationwidePreview.summary.totalCanonicalParks + newCanonicalParks.length
};

const output = {
  generatedAt: new Date().toISOString(),
  mode: "ordu-canonical-preview",
  manifest,
  identityNote:
    "2 of 210 raw features (both named 'Akyazı Sahil Park', ID=null, empty MultiPolygon " +
    "coordinates, no OBJECTID/FID/feature.id anywhere in the schema) were excluded — no " +
    "stable identity AND no geometry exist for them. The remaining 208 features all have a " +
    "unique, non-null 'ID' (0-207), used directly as external_id. No id was fabricated.",
  summary,
  matched,
  safeNameUpgradeCandidates: nameUpgradeCandidates,
  newCanonicalParks,
  review,
  rejectedNonPark,
  invalidGeometry,
  missingStableId,
  invalidCoordinates,
  provinceMismatch
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== ORDU CANONICAL PREVIEW =====");
console.log(summary);
console.log(`\n${output.identityNote}`);
console.log(`\nSaved -> ${outputPath}`);
console.log(
  "\nNOTE: this preview is standalone — NOT yet merged into " +
    "nationwide-canonical-preview.json and NOT written to any DB."
);

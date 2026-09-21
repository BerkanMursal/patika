import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { representativePoint } from "./polygon-geometry.mjs";
import { loadProvinceRegions, provincesContaining, nearestProvince } from "./province-boundaries.mjs";
import { loadDistrictRegions, districtsForProvince, districtsContaining, nearestDistrict } from "./district-boundaries.mjs";

// Generic, config-driven municipal park adapter engine — the single
// implementation behind Konya/Ordu/Trabzon's three previously bespoke
// build-<city>-canonical.mjs scripts (kept on disk, unchanged, as the
// historical/regression reference; this engine is what future sources
// should run through instead of a new one-off script).
//
// A source becomes runnable by adding one config object to
// data/municipal-ingestion-configs.json (see that file's $schema_note) —
// not by writing new code — as long as its shape fits what this engine
// already understands: a single GeoJSON resource, Point or MultiPolygon
// geometry, an id field, a name field, an optional taxonomy filter, and an
// optional district field (or spatial resolution, or none).
//
// Output shape is intentionally identical to the original three scripts'
// preview JSON — this is what scripts/merge-municipal-sources.mjs already
// consumes, so nothing downstream needs to change.

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

// Same Turkish-specific casing rule as the original build-konya-canonical.mjs
// (İ/i vs I/ı needs toLocaleLowerCase("tr"), not a plain JS toLowerCase()).
function turkishTitleCase(value) {
  return clean(value)
    .toLocaleLowerCase("tr")
    .split(" ")
    .map(word => (word ? word[0].toLocaleUpperCase("tr") + word.slice(1) : word))
    .join(" ");
}

function isGenericName(name) {
  const key = nameKey(name);
  return !key || key === nameKey("İsimsiz park") || key === nameKey("Yeşil Alan") || key === nameKey("Park");
}

const TURKEY_BBOX = { minLat: 35, maxLat: 43, minLon: 25, maxLon: 45 };

function coordPlausible(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= TURKEY_BBOX.minLat &&
    lat <= TURKEY_BBOX.maxLat &&
    lon >= TURKEY_BBOX.minLon &&
    lon <= TURKEY_BBOX.maxLon
  );
}

// Lazily-loaded, module-cached shared geometry data — province/district
// boundaries never change between sources in one process run.
let _provinceRegions = null;
let _districtRegions = null;

async function getProvinceRegions(provincesPath) {
  if (!_provinceRegions) _provinceRegions = await loadProvinceRegions(provincesPath);
  return _provinceRegions;
}

async function getDistrictRegions(districtsPath) {
  if (!_districtRegions) _districtRegions = await loadDistrictRegions(districtsPath);
  return _districtRegions;
}

/* -------------------------------------------------
   Per-feature representative point extraction —
   Point passes through as-is; MultiPolygon uses
   point-on-surface (never a centroid that could land
   outside the polygon). Returns null (never throws)
   on anything malformed, so the caller can record a
   soft invalidGeometry entry instead of aborting the
   whole run.
------------------------------------------------- */
function extractPoint(feature, geometryType) {
  const coords = feature.geometry?.coordinates;

  if (geometryType === "Point") {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const [longitude, latitude] = coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  }

  if (geometryType === "MultiPolygon") {
    if (!Array.isArray(coords) || coords.length === 0) return null;
    try {
      const point = representativePoint(coords);
      return { latitude: point.lat, longitude: point.lon };
    } catch {
      return null;
    }
  }

  throw new Error(`Unsupported geometry_type in config: ${geometryType}`);
}

/* -------------------------------------------------
   District resolution — three modes, matching what
   each of the three reference adapters actually did
   (never silently "upgraded" to a mode a source wasn't
   verified against).
------------------------------------------------- */
function resolveDistrict(config, props, longitude, latitude, districtRegions, provinceRegions) {
  if (config.district_resolution === "source_field") {
    const raw = props[config.district_field];
    const value =
      config.district_field_casing === "turkish_title_case_from_upper"
        ? turkishTitleCase(raw)
        : clean(raw);
    return { district: value, method: value ? "source_field" : null };
  }

  if (config.district_resolution === "spatial") {
    const scoped = districtsForProvince(districtRegions, provinceRegions, config.province, provincesContaining);
    const contains = districtsContaining(scoped, longitude, latitude);

    if (contains.length === 1) {
      return { district: contains[0].name, method: "contains" };
    }
    if (contains.length > 1) {
      return { district: null, method: "unresolved_multiple_containing" };
    }

    const nearest = nearestDistrict(scoped, longitude, latitude);
    const maxM = config.district_nearest_fallback_max_m ?? 3000;
    if (nearest && nearest.distance_m <= maxM) {
      return { district: nearest.name, method: `nearest_fallback (${nearest.distance_m}m)` };
    }
    return { district: null, method: "unresolved_too_far" };
  }

  // "none" — source genuinely has no district field and no spatial
  // resolution was verified for it; report honestly empty, never fabricate.
  return { district: "", method: null };
}

/* -------------------------------------------------
   Main entry point
------------------------------------------------- */
export async function runIngestion(config, { nationwidePreview, provincesPath, districtsPath, cacheDirUrl }) {
  if (config.license_status !== "SAFE_OPEN") {
    throw new Error(
      `[${config.source_code}] refusing to run: license_status is '${config.license_status}', not SAFE_OPEN. ` +
        `Unknown/unverified licenses must never become enabled ingestion sources.`
    );
  }

  const geojson = JSON.parse(
    await readFile(new URL(config.raw_filename, cacheDirUrl), "utf8")
  );

  const provinceRegions = await getProvinceRegions(provincesPath);
  const districtRegions =
    config.district_resolution === "spatial" ? await getDistrictRegions(districtsPath) : null;

  const rejectedNonPark = [];
  const invalidGeometry = [];
  const invalidCoordinates = [];
  const provinceMismatch = [];
  const districtUnresolved = [];
  const candidates = [];
  const seenIds = new Set();

  for (const feature of geojson.features) {
    const props = feature.properties ?? {};
    const rawId = props[config.id_field];

    if (rawId === null || rawId === undefined || rawId === "") {
      invalidGeometry.push({ reported_id: rawId ?? null, name: props[config.name_field] ?? null, reason: "missing_id" });
      continue;
    }

    const externalId = String(rawId);

    if (seenIds.has(externalId)) {
      invalidGeometry.push({ reported_id: externalId, name: props[config.name_field] ?? null, reason: "duplicate_id" });
      continue;
    }

    const point = extractPoint(feature, config.geometry_type);
    if (!point) {
      invalidGeometry.push({
        reported_id: externalId,
        name: props[config.name_field] ?? null,
        reason: config.geometry_type === "Point" ? "invalid_point_geometry" : "empty_or_invalid_polygon_geometry"
      });
      continue;
    }

    seenIds.add(externalId);

    if (config.taxonomy_field) {
      const taxonomyValue = props[config.taxonomy_field];
      if (!config.allowed_taxonomy_values?.includes(taxonomyValue)) {
        rejectedNonPark.push({ external_id: externalId, taxonomy_value: taxonomyValue ?? null });
        continue;
      }
    }

    const { latitude, longitude } = point;

    if (!coordPlausible(latitude, longitude)) {
      invalidCoordinates.push({ external_id: externalId, name: props[config.name_field] ?? null, latitude, longitude });
      continue;
    }

    const contains = provincesContaining(provinceRegions, longitude, latitude);
    let resolvedProvince = contains.find(r => r.name === config.province) ? config.province : null;

    if (!resolvedProvince && contains.length === 0) {
      const nearest = nearestProvince(provinceRegions, longitude, latitude);
      const maxM = config.province_nearest_fallback_max_m ?? 2000;
      if (nearest.name === config.province && nearest.distance_m <= maxM) {
        resolvedProvince = config.province;
      }
    }

    if (!resolvedProvince) {
      provinceMismatch.push({
        external_id: externalId,
        name: props[config.name_field] ?? null,
        latitude,
        longitude,
        resolved_provinces: contains.map(r => r.name)
      });
      continue;
    }

    const { district, method: districtMethod } = resolveDistrict(
      config,
      props,
      longitude,
      latitude,
      districtRegions,
      provinceRegions
    );

    if (config.district_resolution === "spatial" && district === null) {
      districtUnresolved.push({ external_id: externalId, name: props[config.name_field] ?? null, latitude, longitude, reason: districtMethod });
    }

    candidates.push({
      external_id: externalId,
      name: clean(props[config.name_field]) || "İsimsiz park",
      source_name_raw: props[config.name_field] ?? null,
      district: district ?? "",
      district_method: districtMethod,
      latitude,
      longitude
    });
  }

  /* -------------------------------------------------
     OSM reconciliation — identical tiered logic for
     every source, parameterized only by
     config.osm_match_tiers_m (derived from geometry
     type when each reference adapter was written:
     [25,150] for Point, [100,300] for MultiPolygon).
  ------------------------------------------------- */

  const existingOsm = nationwidePreview.parks.filter(p => p.city === config.province && p.osm_id);
  const [tier1, tier2] = config.osm_match_tiers_m;

  function nearbyOsm(candidate, radiusMeters) {
    return existingOsm.filter(osm => distanceMeters(candidate, osm) <= radiusMeters);
  }

  const matched = [];
  const provisionalMatched = [];
  const nameUpgradeCandidates = [];
  const newCanonical = [];
  const review = [];

  // Two of the three reference adapters (Konya, Trabzon) check the
  // name-conflict rule BEFORE grouping by shared OSM target; Ordu's
  // original script checks shared-target grouping FIRST, then only runs
  // the name-conflict check on records that survive as the sole claimant
  // of their OSM target. Both orders route a "bad" candidate to review
  // either way (never silently merged), so this never affects
  // matched/new/review counts — but it DOES change which of the two
  // review reasons a borderline record gets, so it must be reproduced
  // exactly per source, not defaulted. Verified against Ordu's original
  // 28/5/81 breakdown (see docs/PARK_DATA_CHECKPOINT.md).
  const nameConflictFirst = (config.matching_check_order ?? "name_conflict_before_grouping") === "name_conflict_before_grouping";

  for (const candidate of candidates) {
    const near1 = nearbyOsm(candidate, tier1);
    const near2 = near1.length ? near1 : nearbyOsm(candidate, tier2);

    if (near2.length === 0) {
      newCanonical.push(candidate);
      continue;
    }

    if (near2.length > 1) {
      review.push({
        reason: "multiple_osm_candidates",
        candidate,
        osm_candidates: near2.map(o => ({ id: o.id, osm_id: o.osm_id, name: o.name }))
      });
      continue;
    }

    const osm = near2[0];
    const candidateGeneric = isGenericName(candidate.name);
    const osmGeneric = isGenericName(osm.name);

    if (nameConflictFirst && !candidateGeneric && !osmGeneric && nameKey(candidate.name) !== nameKey(osm.name)) {
      review.push({
        reason: "name_conflict_at_same_location",
        candidate,
        osm_candidate: { id: osm.id, osm_id: osm.osm_id, name: osm.name }
      });
      continue;
    }

    provisionalMatched.push({ candidate, osm, candidateGeneric, osmGeneric });
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
          other_candidates_targeting_same_park: entries.filter(e => e !== entry).map(e => e.candidate.external_id)
        });
      }
      continue;
    }

    const { candidate, osm, candidateGeneric, osmGeneric } = entries[0];

    if (!nameConflictFirst && !candidateGeneric && !osmGeneric && nameKey(candidate.name) !== nameKey(osm.name)) {
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
        source_code: config.source_code,
        external_id: candidate.external_id,
        source_url: `${config.dataset_url}#${config.external_id_url_param}_${candidate.external_id}`
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

  const newCanonicalParks = newCanonical.map(candidate => ({
    id: deterministicUuid(`${config.id_namespace}:${candidate.external_id}`),
    osm_id: null,
    name: candidate.name,
    city: config.province,
    district: candidate.district,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    source: config.source_display_name,
    name_status: isGenericName(candidate.name) ? "missing" : "municipal",
    name_source: config.source_display_name,
    name_source_url: config.dataset_url,
    source_refs: [
      {
        source_code: config.source_code,
        external_id: candidate.external_id,
        source_url: `${config.dataset_url}#${config.external_id_url_param}_${candidate.external_id}`
      }
    ],
    provenance_metadata: {
      source_name_raw: candidate.source_name_raw,
      district_method: candidate.district_method
    }
  }));

  /* -------------------------------------------------
     Invariants — same checks every reference adapter
     ran, generic now.
  ------------------------------------------------- */

  const newIds = new Set(newCanonicalParks.map(p => p.id));
  if (newIds.size !== newCanonicalParks.length) {
    throw new Error(`[${config.source_code}] duplicate deterministic id among new canonical parks.`);
  }

  const matchedCanonicalIds = matched.map(m => m.canonical_id);
  if (new Set(matchedCanonicalIds).size !== matchedCanonicalIds.length) {
    throw new Error(`[${config.source_code}] same OSM canonical park matched by more than one source record — must go to review.`);
  }

  const candidateExternalIds = candidates.map(c => c.external_id);
  if (new Set(candidateExternalIds).size !== candidateExternalIds.length) {
    throw new Error(`[${config.source_code}] duplicate external_id reached the candidate stage — identity assumption violated.`);
  }

  const districtResolvedCount = candidates.filter(c => c.district).length;
  const districtMissingCount = candidates.filter(c => !c.district).length;

  const reviewBreakdown = {};
  for (const r of review) reviewBreakdown[r.reason] = (reviewBreakdown[r.reason] ?? 0) + 1;

  const summary = {
    sourceCode: config.source_code,
    rawFeatures: geojson.features.length,
    parkCandidates: candidates.length,
    validGeometry: candidates.length,
    rejectedNonPark: rejectedNonPark.length,
    invalidGeometry: invalidGeometry.length,
    invalidCoordinates: invalidCoordinates.length,
    provinceMismatch: provinceMismatch.length,
    districtResolved: districtResolvedCount,
    districtMissing: districtMissingCount,
    districtUnresolved: districtUnresolved.length,
    matchedExisting: matched.length,
    safeNameUpgradeCandidates: nameUpgradeCandidates.length,
    newCanonical: newCanonicalParks.length,
    review: review.length,
    duplicateSourceRecords: 0,
    sourceRefsProduced: matched.length + newCanonicalParks.length,
    license: config.license_status,
    attribution: config.attribution,
    canonicalTotalBefore: nationwidePreview.summary.totalCanonicalParks,
    canonicalTotalAfter: nationwidePreview.summary.totalCanonicalParks + newCanonicalParks.length
  };

  return {
    generatedAt: new Date().toISOString(),
    mode: `${config.source_code}-canonical-preview`,
    engine: "generic-municipal-ingestion-engine",
    config: { source_code: config.source_code, province: config.province, geometry_type: config.geometry_type },
    summary,
    reviewBreakdown,
    matched,
    safeNameUpgradeCandidates: nameUpgradeCandidates,
    newCanonicalParks,
    review,
    rejectedNonPark,
    invalidGeometry,
    invalidCoordinates,
    provinceMismatch,
    districtUnresolved
  };
}

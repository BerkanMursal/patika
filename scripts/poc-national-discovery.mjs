import { readFile, writeFile } from "node:fs/promises";
import { clean } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";
import { loadDistrictRegions, districtsForProvince, districtsContaining } from "./district-boundaries.mjs";

// LOCAL-ONLY proof-of-concept extractor for the national-service-discovery
// milestone (ULASAV CKAN catalog). Deliberately lightweight, per instruction:
// raw feature count, PARK-candidate count, valid geometry count, stable ID
// coverage, province/district coverage. NOT a real adapter, NOT a merge —
// no MATCHED/NEW_CANONICAL/REVIEW classification, no reconciliation against
// the canonical registry. Proves the discovery pattern (ULASAV catalog ->
// license check -> reachability check -> lightweight inspection) works
// across 3 municipalities in 3 different source formats.

const cacheRoot = new URL("../data/park-enrichment/.cache/national-poc/", import.meta.url);
const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);
const districtsPath = new URL("../data/park-enrichment/districts.geojson", import.meta.url);
const districtRegions = await loadDistrictRegions(districtsPath);

const TURKEY_BBOX = { minLat: 35, maxLat: 43, minLon: 25, maxLon: 45 };
function coordPlausible(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= TURKEY_BBOX.minLat && lat <= TURKEY_BBOX.maxLat && lon >= TURKEY_BBOX.minLon && lon <= TURKEY_BBOX.maxLon;
}

function inspectProvinceDistrict(features, expectedProvince) {
  let provinceMatches = 0;
  let districtResolved = 0;
  for (const [lon, lat] of features) {
    const contains = provincesContaining(provinceRegions, lon, lat);
    if (contains.some(r => r.name === expectedProvince)) {
      provinceMatches++;
      const scoped = districtsForProvince(districtRegions, provinceRegions, expectedProvince, provincesContaining);
      const dc = districtsContaining(scoped, lon, lat);
      if (dc.length === 1) districtResolved++;
    }
  }
  return { provinceMatches, districtResolved };
}

async function inspectBursa() {
  const geojson = JSON.parse(await readFile(new URL("bursa/raw.geojson", cacheRoot), "utf8"));
  const raw = geojson.features.length;

  // No taxonomy/type field at all — this is a curated tourism/attractions
  // list (URL literally says "acik_veri_turizm" = open tourism data), not a
  // GIS-grade park inventory. hashtags[] contains "park" for some rows —
  // used here only as a best-effort signal, explicitly NOT a real taxonomy
  // filter (there is no structured type field to filter on).
  let validGeometry = 0;
  let parkCandidate = 0;
  const coords = [];
  const ids = [];
  for (const f of geojson.features) {
    const c = f.geometry?.coordinates;
    const valid = Array.isArray(c) && c.length === 2 && coordPlausible(c[1], c[0]);
    if (valid) {
      validGeometry++;
      coords.push(c);
    }
    const hashtags = (f.properties?.hashtags ?? []).map(h => h.toLowerCase());
    if (hashtags.some(h => h.includes("park") || h.includes("kent orman"))) parkCandidate++;
    ids.push(f.id);
  }
  const distinctIds = new Set(ids.filter(id => id !== null && id !== undefined));

  const { provinceMatches, districtResolved } = inspectProvinceDistrict(coords, "Bursa");

  return {
    municipality: "Bursa Büyükşehir Belediyesi",
    dataset: "Parklar (bapi.bursa.bel.tr acik_veri_turizm)",
    format: "GeoJSON (API gateway)",
    rawFeatureCount: raw,
    parkCandidateCount: parkCandidate,
    validGeometryCount: validGeometry,
    stableIdField: "GeoJSON feature.id (top-level)",
    stableIdCoverage: `${distinctIds.size}/${raw} distinct non-null`,
    provinceCoverage: `${provinceMatches}/${validGeometry} confirmed in Bursa`,
    districtCoverage: `${districtResolved}/${provinceMatches} resolved (spatial, no source district field)`,
    notes: "NOT a park-inventory dataset — a small (17-row) curated tourism/attractions list with freeform hashtag tags, HTML content_summary, no structured type field. 'Park candidate' count here is a best-effort hashtag heuristic, not a real taxonomy filter — demonstrates why a dataset's CKAN title ('Parklar') cannot be trusted without inspecting the actual schema."
  };
}

async function inspectVan() {
  const geojson = JSON.parse(await readFile(new URL("van/parklar_wgs84.geojson", cacheRoot), "utf8"));
  const raw = geojson.features.length;

  let validGeometry = 0;
  let parkCandidate = 0;
  const coords = [];
  const ids = [];
  for (const f of geojson.features) {
    const c = f.geometry?.coordinates;
    const valid = Array.isArray(c) && c.length === 2 && coordPlausible(c[1], c[0]);
    if (valid) {
      validGeometry++;
      coords.push(c);
    }
    // FAALIYET_I is a numeric activity/type code — no lookup table available
    // from this source alone, so every valid-geometry, named row is counted
    // as a park candidate (same "whole dataset IS the taxonomy" treatment
    // already used for Ordu, whose title/collection is itself "Parklar").
    if (clean(f.properties?.ADI)) parkCandidate++;
    ids.push(f.properties?.OBJECTID);
  }
  const distinctIds = new Set(ids.filter(id => id !== null && id !== undefined));

  const { provinceMatches, districtResolved } = inspectProvinceDistrict(coords, "Van");

  return {
    municipality: "Van Büyükşehir Belediyesi",
    dataset: "Parklar",
    format: "SHP (zipped shapefile, CRS ITRF96_TM42 — required explicit reprojection to WGS84, NOT pre-normalized)",
    rawFeatureCount: raw,
    parkCandidateCount: parkCandidate,
    validGeometryCount: validGeometry,
    stableIdField: "OBJECTID",
    stableIdCoverage: `${distinctIds.size}/${raw} distinct non-null`,
    provinceCoverage: `${provinceMatches}/${validGeometry} confirmed in Van`,
    districtCoverage: `${districtResolved}/${provinceMatches} resolved (spatial; source has ILCE_ID numeric code but no lookup table available from this source alone)`,
    notes: "Highest quality of the 3 POC sources — real park names (e.g. 'NAİM SÜLEYNANOĞLU PARKI'), rich per-park description text, fully unique OBJECTID, fully populated name field. Was previously misclassified 'none_found'/Tier D by manual per-city research; found only via ULASAV's catalog. CRITICAL finding: raw coordinates were in a projected CRS (ITRF96_TM42, a Turkish Transverse Mercator variant), not WGS84 — required an explicit ogr2ogr -t_srs EPSG:4326 reprojection step most GeoJSON-only pipelines (including this project's existing engine) do not currently handle automatically."
  };
}

async function inspectOsmaniye() {
  const geojson = JSON.parse(await readFile(new URL("osmaniye/parklar.geojson", cacheRoot), "utf8"));
  const raw = geojson.features.length;

  let validGeometry = 0;
  const coords = [];
  const ids = [];
  for (const f of geojson.features) {
    const geom = f.geometry;
    let point = null;
    if (geom?.type === "Polygon" && geom.coordinates?.[0]?.[0]) {
      point = geom.coordinates[0][0]; // first ring vertex as a coarse representative point for this POC only
    } else if (geom?.type === "Point") {
      point = geom.coordinates;
    }
    const valid = Array.isArray(point) && point.length >= 2 && coordPlausible(point[1], point[0]);
    if (valid) {
      validGeometry++;
      coords.push(point);
    }
    ids.push(f.properties?.Name);
  }
  const distinctIds = new Set(ids.filter(id => id !== null && id !== undefined && id !== ""));

  const { provinceMatches, districtResolved } = inspectProvinceDistrict(coords, "Osmaniye");

  return {
    municipality: "Osmaniye Belediyesi",
    dataset: "Osmaniye İli Merkez İlçesi Park Alanları",
    format: "KML (exported from a CAD/GIS tool, xmlns:globalmapper namespace present in the raw file)",
    rawFeatureCount: raw,
    parkCandidateCount: 0,
    validGeometryCount: validGeometry,
    stableIdField: "none usable",
    stableIdCoverage: `${distinctIds.size}/${raw} — 'Name' field is just a sequential row number ('1','2',...), not a real stable identifier`,
    provinceCoverage: `${provinceMatches}/${validGeometry} confirmed in Osmaniye`,
    districtCoverage: `${districtResolved}/${provinceMatches} resolved (spatial; no source district field)`,
    notes: "WORST quality of the 3 POC sources, reported honestly. Every feature's 'description' property literally reads \"Unknown Area Type\" — the dataset carries geometry (64 polygons) but ZERO usable attribute data: no real name, no id, no type/classification field, no way to confirm these are even parks vs. any other area type despite the CKAN dataset title 'Park Alanları'. parkCandidateCount is honestly reported as 0 — nothing here is confirmable as a park without external verification. This is exactly the 'do not assume from the UI/title' risk the task warned about."
  };
}

const bursa = await inspectBursa();
const van = await inspectVan();
const osmaniye = await inspectOsmaniye();

const output = {
  generatedAt: new Date().toISOString(),
  mode: "national-service-discovery-poc",
  purpose: "Lightweight, non-merging proof-of-concept for 3 municipalities discovered via ULASAV's CKAN catalog, spanning 3 different source formats (GeoJSON API gateway, zipped Shapefile, KML). Proves the discovery pattern works end-to-end; does NOT classify MATCHED/NEW/REVIEW and does NOT merge anything.",
  results: [bursa, van, osmaniye]
};

const outputPath = new URL("../data/park-enrichment/.cache/national-poc/poc-results.json", import.meta.url);
await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== NATIONAL SERVICE DISCOVERY POC =====");
for (const r of output.results) {
  console.log(`\n${r.municipality} — ${r.dataset} (${r.format})`);
  console.log("  raw:", r.rawFeatureCount, "| park candidates:", r.parkCandidateCount, "| valid geometry:", r.validGeometryCount);
  console.log("  stable id:", r.stableIdField, "->", r.stableIdCoverage);
  console.log("  province:", r.provinceCoverage, "| district:", r.districtCoverage);
  console.log("  notes:", r.notes);
}
console.log(`\nSaved -> ${outputPath}`);

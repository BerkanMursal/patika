import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { representativePoint } from "./polygon-geometry.mjs";
import {
  loadProvinceRegions,
  provincesContaining,
  nearestProvince
} from "./province-boundaries.mjs";
import { geometryIndex, containing, clean } from "./park-enrichment.mjs";

const cacheDir = new URL(
  "../data/park-enrichment/.cache/geofabrik/",
  import.meta.url
);

const pointsPath = new URL("points.geojson", cacheDir);
const multipolygonsPath = new URL("multipolygons.geojson", cacheDir);
const manifestPath = new URL("manifest.json", cacheDir);

const outputPath =
  process.env.NATIONWIDE_PBF_BASELINE_OUTPUT ||
  new URL("nationwide-pbf-catalog.json", cacheDir);

const provincesPath = new URL(
  "../../../provinces.geojson",
  cacheDir
);

const districtsPath = new URL(
  "../../districts.geojson",
  cacheDir
);

const points = JSON.parse(await readFile(pointsPath, "utf8"));
const multipolygons = JSON.parse(
  await readFile(multipolygonsPath, "utf8")
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const provinceRegions = await loadProvinceRegions(provincesPath);
const districtIndex = geometryIndex(
  JSON.parse(await readFile(districtsPath, "utf8")).features
);

function deterministicUuid(value) {
  const bytes = createHash("sha256")
    .update(value)
    .digest()
    .subarray(0, 16);

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

function tagsFromProperties(props) {
  return {
    name: props.name || "",
    "name:tr": props.name_tr || "",
    official_name: props.official_name || "",
    loc_name: props.loc_name || "",
    "addr:city": props.addr_city || "",
    "addr:district": props.addr_district || "",
    "addr:suburb": props.addr_suburb || ""
  };
}

const provinceAssignmentAudit = [];
const districtUnresolvedCount = { multiple: 0 };

function assignProvince(osmId, lon, lat) {
  const contains = provincesContaining(provinceRegions, lon, lat);

  if (contains.length === 1) {
    return { name: contains[0].name, method: "contains" };
  }

  if (contains.length > 1) {
    const sorted = [...contains].sort((a, b) =>
      a.name.localeCompare(b.name, "tr")
    );

    provinceAssignmentAudit.push({
      osm_id: osmId,
      method: "multiple_contains_first_alpha",
      candidates: sorted.map(r => r.name),
      chosen: sorted[0].name
    });

    return { name: sorted[0].name, method: "multiple_contains_first_alpha" };
  }

  const nearest = nearestProvince(provinceRegions, lon, lat);

  provinceAssignmentAudit.push({
    osm_id: osmId,
    method: "nearest_fallback",
    chosen: nearest.name,
    distance_m: nearest.distance_m
  });

  return { name: nearest.name, method: "nearest_fallback", distance_m: nearest.distance_m };
}

function assignDistrict(tags, lon, lat) {
  const tagged = clean(tags["addr:district"]) || clean(tags["addr:suburb"]);
  if (tagged) return tagged;

  const matches = containing(districtIndex, lon, lat);
  if (matches.length === 1) return clean(matches[0].properties.shapeName);
  if (matches.length > 1) districtUnresolvedCount.multiple++;
  return "";
}

function buildRow(osmType, numId, lat, lon, tags) {
  const osm_id = `${osmType}/${numId}`;
  const name = clean(tags["name:tr"]) || clean(tags.name) || "İsimsiz park";
  const province = assignProvince(osm_id, lon, lat);
  const district = assignDistrict(tags, lon, lat);

  return {
    id: deterministicUuid(`patika-osm:${osm_id}`),
    osm_id,
    entity_type: osmType,
    name,
    city: province.name,
    province_assignment_method: province.method,
    district,
    latitude: lat,
    longitude: lon
  };
}

function inTurkeyBbox(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 35 &&
    lat <= 43 &&
    lon >= 25 &&
    lon <= 45
  );
}

const rows = [];
const rejectedCoordinates = [];

for (const feature of points.features) {
  const [lon, lat] = feature.geometry.coordinates;
  if (!inTurkeyBbox(lat, lon)) {
    rejectedCoordinates.push(`node/${feature.properties.osm_id}`);
    continue;
  }

  rows.push(
    buildRow(
      "node",
      feature.properties.osm_id,
      lat,
      lon,
      tagsFromProperties(feature.properties)
    )
  );
}

for (const feature of multipolygons.features) {
  const isWay = Boolean(feature.properties.osm_way_id);
  const numId = isWay ? feature.properties.osm_way_id : feature.properties.osm_id;
  const point = representativePoint(feature.geometry.coordinates);

  if (!inTurkeyBbox(point.lat, point.lon)) {
    rejectedCoordinates.push(`${isWay ? "way" : "relation"}/${numId}`);
    continue;
  }

  rows.push(
    buildRow(
      isWay ? "way" : "relation",
      numId,
      point.lat,
      point.lon,
      tagsFromProperties(feature.properties)
    )
  );
}

if (rejectedCoordinates.length) {
  throw new Error(
    `Coordinates outside Turkey bbox: ${rejectedCoordinates.slice(0, 10)}`
  );
}

/* -------------------------------------------------
   Invariants
------------------------------------------------- */

const ids = new Set();
const osmIds = new Set();
const officialNames = new Set(provinceRegions.map(r => r.name));
const invalidProvince = [];

for (const row of rows) {
  if (ids.has(row.id)) throw new Error(`Duplicate canonical id: ${row.id}`);
  ids.add(row.id);

  if (osmIds.has(row.osm_id)) throw new Error(`Duplicate OSM id: ${row.osm_id}`);
  osmIds.add(row.osm_id);

  if (!officialNames.has(row.city)) invalidProvince.push(row.osm_id);
}

if (invalidProvince.length) {
  throw new Error(
    `Province outside official 81-name registry: ${invalidProvince.slice(0, 10)}`
  );
}

const distinctProvinces = new Set(rows.map(r => r.city));

const byEntityType = {
  node: rows.filter(r => r.entity_type === "node").length,
  way: rows.filter(r => r.entity_type === "way").length,
  relation: rows.filter(r => r.entity_type === "relation").length
};

const summary = {
  totalRows: rows.length,
  byEntityType,
  distinctProvinceCount: distinctProvinces.size,
  provincesMissingFromDataset: [...officialNames].filter(
    name => !distinctProvinces.has(name)
  ),
  provinceAssignedByContainment: rows.filter(
    r => r.province_assignment_method === "contains"
  ).length,
  provinceAssignedByNearestFallback: rows.filter(
    r => r.province_assignment_method === "nearest_fallback"
  ).length,
  provinceAssignedByMultipleContainsFirstAlpha: rows.filter(
    r => r.province_assignment_method === "multiple_contains_first_alpha"
  ).length,
  districtMissing: rows.filter(r => !r.district).length,
  districtAmbiguousMultipleMatches: districtUnresolvedCount.multiple,
  duplicateCanonicalIds: 0,
  duplicateOsmIds: 0,
  invalidProvinceValues: 0
};

const output = {
  generatedAt: new Date().toISOString(),
  mode: "nationwide-pbf-baseline",
  pbfSource: {
    resolvedUrl: manifest.resolvedUrl,
    resolvedFilename: manifest.resolvedFilename,
    md5: manifest.expectedMd5,
    lastModified: manifest.lastModified,
    fetchedAt: manifest.fetchedAt,
    license: manifest.license,
    attribution: manifest.attribution
  },
  filter: "leisure=park",
  summary,
  rows,
  provinceAssignmentAudit
};

await writeFile(outputPath, JSON.stringify(output));

console.log("===== NATIONWIDE PBF BASELINE =====");
console.log(summary);
console.log(`\nProvince assignment audit entries: ${provinceAssignmentAudit.length}`);
console.log(`Saved -> ${outputPath}`);

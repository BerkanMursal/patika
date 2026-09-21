import { readFile, writeFile } from "node:fs/promises";
import {
  loadProvinceRegions,
  officialProvinceNames,
  provincesContaining,
  nearestProvince
} from "./province-boundaries.mjs";
import { loadNationwideOsmSource } from "./nationwide-osm-source.mjs";

const provincesPath = new URL(
  "../data/provinces.geojson",
  import.meta.url
);

// Prefer the reconciled İzmir file (scripts/build-izmir-canonical-reconciled.mjs
// re-derives İzmir's OSM-backed set from the SAME fresh OSM source used below,
// with the V2 municipal evidence re-attached by osm_id). Fall back to the
// frozen V2 file only if reconciliation hasn't been run — but never let İzmir
// silently keep stale OSM data while the rest of the country gets refreshed.
const izmirReconciledPath =
  process.env.IZMIR_CANONICAL_RECONCILED ||
  new URL(
    "../data/park-enrichment/.cache/izmir-canonical-reconciled.json",
    import.meta.url
  );

const izmirV2Path =
  process.env.IZMIR_CANONICAL_V2 ||
  new URL(
    "../data/park-enrichment/.cache/izmir-canonical-v2.json",
    import.meta.url
  );

const outputPath =
  process.env.NATIONWIDE_CANONICAL_OUTPUT ||
  new URL(
    "../data/park-enrichment/.cache/nationwide-canonical-preview.json",
    import.meta.url
  );

const {
  rows: osmSource,
  label: osmSourceLabel,
  pbfSource: pbfSourceMetadata
} = await loadNationwideOsmSource();

const provinceRegions = await loadProvinceRegions(provincesPath);
const officialProvinces = officialProvinceNames(provinceRegions);

function osmCanonicalFromCatalogRow(row) {
  const [id, osm_id, name, city, district, latitude, longitude] = row;

  return {
    id,
    osm_id,
    name,
    city,
    district,
    latitude,
    longitude,
    source: "OpenStreetMap",
    source_refs: [
      {
        source_code: "osm",
        external_id: osm_id,
        source_url: `https://www.openstreetmap.org/${osm_id}`
      }
    ]
  };
}

let izmirDocument = null;
let izmirSourceKind = "none";

try {
  izmirDocument = JSON.parse(await readFile(izmirReconciledPath, "utf8"));

  if (izmirDocument.mode !== "izmir-canonical-reconciled") {
    throw new Error(`Unexpected İzmir dataset mode: ${izmirDocument.mode}`);
  }

  izmirSourceKind = "reconciled";
} catch (error) {
  if (error.code !== "ENOENT") throw error;

  try {
    izmirDocument = JSON.parse(await readFile(izmirV2Path, "utf8"));

    if (izmirDocument.mode !== "canonical-v2-preview") {
      throw new Error(`Unexpected İzmir dataset mode: ${izmirDocument.mode}`);
    }

    izmirSourceKind = "frozen-v2";
  } catch (innerError) {
    if (innerError.code !== "ENOENT") throw innerError;
  }
}

/* -------------------------------------------------
   Assemble canonical parks: nationwide OSM baseline
   for every province except İzmir, and İzmir's own
   result (reconciled against the fresh OSM source
   above when available, else the frozen V2 file, else
   plain OSM-only) in its place.
------------------------------------------------- */

const parks = [];

for (const row of osmSource) {
  if (row[3] === "İzmir") continue;
  parks.push(osmCanonicalFromCatalogRow(row));
}

if (izmirDocument) {
  for (const park of izmirDocument.parks) {
    const osmBacked = Boolean(park.osm_id);

    parks.push({
      id: park.id,
      osm_id: park.osm_id ?? null,
      name: park.name,
      city: park.city || "İzmir",
      district: park.district,
      latitude: park.latitude,
      longitude: park.longitude,
      source: osmBacked
        ? "OpenStreetMap"
        : "İzmir Büyükşehir Belediyesi Kent Rehberi",
      name_status: park.name_status,
      name_source: park.name_source,
      name_source_url: park.name_source_url,
      source_refs: park.source_refs ?? []
    });
  }
} else {
  for (const row of osmSource) {
    if (row[3] !== "İzmir") continue;
    parks.push(osmCanonicalFromCatalogRow(row));
  }
}

/* -------------------------------------------------
   Province normalization — coordinate-based only,
   never a blind string rewrite. A park's city value
   can be missing or, in principle, some unexpected
   string; when it isn't one of the 81 official
   province names, resolve it by distance to the same
   province polygons (containment first, then nearest
   boundary) instead of guessing from the string.
   Every fix is recorded for audit.
------------------------------------------------- */

const provinceNormalization = [];

for (const park of parks) {
  if (officialProvinces.has(park.city)) continue;

  const originalCity = park.city;
  const contains = provincesContaining(provinceRegions, park.longitude, park.latitude);

  const resolved =
    contains.length >= 1
      ? contains[0].name
      : nearestProvince(provinceRegions, park.longitude, park.latitude).name;

  park.city = resolved;

  provinceNormalization.push({
    id: park.id,
    osm_id: park.osm_id,
    original_city: originalCity,
    resolved_city: resolved,
    method: contains.length >= 1 ? "contains" : "nearest_fallback"
  });
}

/* -------------------------------------------------
   Nationwide invariants — fail loudly, never merge
   silently. Mirrors build-izmir-canonical-v2.mjs.
------------------------------------------------- */

const ids = new Set();
const osmIds = new Set();
const refs = new Map();
const invalidCoordinates = [];
const invalidProvinces = [];

for (const park of parks) {
  if (ids.has(park.id)) {
    throw new Error(`Duplicate canonical id: ${park.id}`);
  }

  ids.add(park.id);

  if (park.osm_id) {
    if (osmIds.has(park.osm_id)) {
      throw new Error(`Duplicate OSM id: ${park.osm_id}`);
    }

    osmIds.add(park.osm_id);
  }

  for (const ref of park.source_refs ?? []) {
    const key = `${ref.source_code}:${ref.external_id}`;

    if (refs.has(key)) {
      throw new Error(
        `Duplicate source ref ${key}: ${refs.get(key)} and ${park.id}`
      );
    }

    refs.set(key, park.id);
  }

  if (
    !Number.isFinite(park.latitude) ||
    !Number.isFinite(park.longitude) ||
    park.latitude < 35 ||
    park.latitude > 43 ||
    park.longitude < 25 ||
    park.longitude > 45
  ) {
    invalidCoordinates.push(park.id);
  }

  if (!officialProvinces.has(park.city)) {
    invalidProvinces.push({ id: park.id, city: park.city });
  }
}

if (invalidProvinces.length) {
  throw new Error(
    `Province outside official 81-name registry after normalization: ${JSON.stringify(invalidProvinces.slice(0, 10))}`
  );
}

if (invalidCoordinates.length) {
  throw new Error(
    `Invalid coordinates: ${invalidCoordinates.slice(0, 10)}`
  );
}

const byProvince = new Map();

for (const park of parks) {
  const key = park.city || "(atanmamış)";
  byProvince.set(key, (byProvince.get(key) ?? 0) + 1);
}

const summary = {
  totalCanonicalParks: parks.length,
  osmBackedParks: parks.filter(p => p.osm_id).length,
  municipalOnlyParks: parks.filter(p => !p.osm_id).length,
  totalSourceRefs: refs.size,
  distinctProvinceCount: byProvince.size,
  osmSource: osmSourceLabel,
  izmirSourceKind,
  provinceNormalizationFixes: provinceNormalization.length,
  duplicateCanonicalIds: 0,
  duplicateOsmIds: 0,
  duplicateSourceRefs: 0,
  invalidCoordinates: 0,
  invalidProvinces: 0
};

const output = {
  generatedAt: new Date().toISOString(),
  mode: "nationwide-canonical-preview",
  osmSource: osmSourceLabel,
  pbfSource: pbfSourceMetadata,
  izmirSourceKind,
  izmirSource:
    izmirSourceKind === "reconciled"
      ? String(izmirReconciledPath)
      : izmirSourceKind === "frozen-v2"
        ? String(izmirV2Path)
        : null,
  summary,
  provinceNormalization,
  parks
};

await writeFile(outputPath, JSON.stringify(output));

console.log("===== NATIONWIDE CANONICAL PREVIEW =====");
console.log(summary);

if (izmirSourceKind === "frozen-v2") {
  console.log(
    "\nNOT: İzmir canonical RECONCILED cache bulunamadı; frozen V2 kullanıldı — " +
      "fresh OSM refresh İzmir'e yansımıyor olabilir. Önce " +
      "scripts/build-izmir-canonical-reconciled.mjs çalıştırın."
  );
} else if (izmirSourceKind === "none") {
  console.log(
    "\nNOT: İzmir canonical cache (reconciled veya V2) bulunamadı; İzmir OSM-only " +
      "olarak işlendi. Önce mevcut İzmir pipeline'ını çalıştırın."
  );
}

console.log(`\nSaved -> ${outputPath}`);

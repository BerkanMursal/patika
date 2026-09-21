import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";

// Adapter pipeline for the Konya açık veri "Parklar" source (Tier A,
// SAFE_OPEN, re-verified 2026-09-21 — see data/municipal-park-sources.json):
//   fetch (scripts/download-konya-parks.mjs, already run)
//     -> normalize -> taxonomy filter -> geometry/point validation
//     -> province/district -> OSM reconciliation -> source refs
//     -> NEW_CANONICAL / MATCHED / REVIEW / REJECTED_NON_PARK -> audit
// Preview/audit only. Never writes the DB, never merges into
// nationwide-canonical-preview.json in this pass — that is a separate,
// deliberate next step once this source's own preview is reviewed.

const cacheDir = new URL(
  "../data/park-enrichment/.cache/konya/",
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

const outputPath = new URL("konya-canonical-preview.json", cacheDir);

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

// ILCEADI arrives as all-caps ("SEYDİŞEHİR"); the rest of the canonical
// dataset uses Turkish title case ("Bornova"). Turkish-specific: the
// lowercase of "İ" is "i" (not "ı"), so a plain JS toLowerCase() would
// corrupt dotted/dotless I — toLocaleLowerCase("tr") handles it correctly,
// same as mobile/src/core/domain.ts's normalizeSearch already does.
function turkishTitleCase(value) {
  return clean(value)
    .toLocaleLowerCase("tr")
    .split(" ")
    .map(word =>
      word ? word[0].toLocaleUpperCase("tr") + word.slice(1) : word
    )
    .join(" ");
}

const SOURCE_CODE = "konya_acikveri_parklar";
const SOURCE_URL_BASE = "https://acikveri.konya.bel.tr/tr/dataset/parklar";

/* -------------------------------------------------
   Normalize + taxonomy filter + geometry validation
------------------------------------------------- */

const rejectedNonPark = [];
const invalidCoordinates = [];
const provinceMismatch = [];
const candidates = [];

for (const feature of geojson.features) {
  const props = feature.properties;

  if (props.ALT_NITELIK_ADI !== "PARK") {
    rejectedNonPark.push({ poi_id: props.POI_ID, alt_nitelik_adi: props.ALT_NITELIK_ADI });
    continue;
  }

  const [longitude, latitude] = feature.geometry.coordinates;

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < 35 ||
    latitude > 43 ||
    longitude < 25 ||
    longitude > 45
  ) {
    invalidCoordinates.push(props.POI_ID);
    continue;
  }

  const contains = provincesContaining(provinceRegions, longitude, latitude);
  if (!contains.some(r => r.name === "Konya")) {
    provinceMismatch.push({
      poi_id: props.POI_ID,
      latitude,
      longitude,
      resolved_provinces: contains.map(r => r.name)
    });
    continue;
  }

  candidates.push({
    external_id: String(props.POI_ID),
    name: clean(props.POI_ADI) || "İsimsiz park",
    district: turkishTitleCase(props.ILCEADI),
    latitude,
    longitude
  });
}

/* -------------------------------------------------
   OSM reconciliation — conservative, tiered radius,
   same spirit as the İzmir V2 canonicalizer: a single
   unambiguous nearby OSM park is a safe match; more
   than one, or none within the tolerance, goes to
   review or becomes a new municipal-only park. Never
   auto-merge an ambiguous case.
------------------------------------------------- */

const existingKonyaOsm = nationwidePreview.parks.filter(
  p => p.city === "Konya" && p.osm_id
);

function isGenericName(name) {
  const key = nameKey(name);
  return !key || key === nameKey("İsimsiz park") || key === nameKey("Yeşil Alan") || key === nameKey("Park");
}

function nearbyOsm(candidate, radiusMeters) {
  return existingKonyaOsm.filter(
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

// A single OSM canonical park matched by more than one Konya record is not
// auto-mergeable — it might be two legitimate sub-features of the same
// park, or duplicate/messy source rows, and this pipeline can't tell which
// without a human. Every candidate touching a contested target goes to
// review instead of being silently attached.
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

  matched.push({
    canonical_id: osm.id,
    osm_id: osm.osm_id,
    source_ref: {
      source_code: SOURCE_CODE,
      external_id: candidate.external_id,
      source_url: `${SOURCE_URL_BASE}#poi_${candidate.external_id}`
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
  id: deterministicUuid(`patika-konya-acikveri:${candidate.external_id}`),
  osm_id: null,
  name: candidate.name,
  city: "Konya",
  district: candidate.district,
  latitude: candidate.latitude,
  longitude: candidate.longitude,
  source: "Konya Büyükşehir Belediyesi Açık Veri Platformu",
  name_status: isGenericName(candidate.name) ? "missing" : "municipal",
  name_source: "Konya Büyükşehir Belediyesi Açık Veri Platformu",
  name_source_url: SOURCE_URL_BASE,
  source_refs: [
    {
      source_code: SOURCE_CODE,
      external_id: candidate.external_id,
      source_url: `${SOURCE_URL_BASE}#poi_${candidate.external_id}`
    }
  ]
}));

/* -------------------------------------------------
   Invariants
------------------------------------------------- */

const newIds = new Set(newCanonicalParks.map(p => p.id));
if (newIds.size !== newCanonicalParks.length) {
  throw new Error("Duplicate deterministic id among new Konya municipal-only parks.");
}

const matchedCanonicalIds = matched.map(m => m.canonical_id);
if (new Set(matchedCanonicalIds).size !== matchedCanonicalIds.length) {
  throw new Error("Same OSM canonical park matched by more than one Konya source record — must go to review instead.");
}

const districtMissing = candidates.filter(c => !c.district).length;

const summary = {
  sourceCode: SOURCE_CODE,
  rawFeatures: geojson.features.length,
  parkCandidates: candidates.length,
  rejectedNonPark: rejectedNonPark.length,
  invalidCoordinates: invalidCoordinates.length,
  provinceMismatch: provinceMismatch.length,
  districtMissing,
  matchedExisting: matched.length,
  safeNameUpgradeCandidates: nameUpgradeCandidates.length,
  newCanonical: newCanonicalParks.length,
  review: review.length,
  duplicateSourceRecords: 0,
  license: manifest.licenseName,
  attribution: "Konya Büyükşehir Belediyesi",
  canonicalTotalBefore: nationwidePreview.summary.totalCanonicalParks,
  canonicalTotalAfter:
    nationwidePreview.summary.totalCanonicalParks + newCanonicalParks.length
};

const output = {
  generatedAt: new Date().toISOString(),
  mode: "konya-canonical-preview",
  manifest,
  summary,
  matched,
  safeNameUpgradeCandidates: nameUpgradeCandidates,
  newCanonicalParks,
  review,
  rejectedNonPark,
  invalidCoordinates,
  provinceMismatch
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== KONYA CANONICAL PREVIEW =====");
console.log(summary);
console.log(`\nSaved -> ${outputPath}`);
console.log(
  "\nNOTE: this preview is standalone — NOT yet merged into " +
    "nationwide-canonical-preview.json and NOT written to any DB."
);

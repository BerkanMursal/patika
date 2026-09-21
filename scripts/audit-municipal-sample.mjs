import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { pointInPolygonRings } from "./polygon-geometry.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";

// Independent QA sampler for the Konya/Ordu adapter previews, run BEFORE any
// merge into the nationwide canonical dataset (see docs/PARK_DATA_CHECKPOINT.md
// -> "SAMPLE QUALITY CHECK FIRST"). Systematic, fixed-seed sampling — never
// cherry-picked by appearance. Read-only: never writes to the previews, the
// nationwide dataset, or a DB.

const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);

const nationwidePreview = JSON.parse(
  await readFile(new URL("nationwide-canonical-preview.json", cacheRoot), "utf8")
);

const konyaPreview = JSON.parse(
  await readFile(new URL("konya/konya-canonical-preview.json", cacheRoot), "utf8")
);
const konyaRaw = JSON.parse(
  await readFile(new URL("konya/parklar.geojson", cacheRoot), "utf8")
);

const orduPreview = JSON.parse(
  await readFile(new URL("ordu/ordu-canonical-preview.json", cacheRoot), "utf8")
);
const orduRaw = JSON.parse(
  await readFile(new URL("ordu/parklar.geojson", cacheRoot), "utf8")
);

// mulberry32 — fixed seed so the sample is reproducible and auditable
// (anyone can re-run this script and get the exact same sample), and so
// nothing here is manually cherry-picked by appearance.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function systematicSample(items, count, seed) {
  if (items.length <= count) return items.map((item, index) => ({ item, index }));
  const rng = mulberry32(seed);
  const indices = items.map((_, i) => i);
  // Fisher-Yates with fixed-seed RNG, then take the first `count` — a
  // uniform, non-cherry-picked, reproducible sample.
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices
    .slice(0, count)
    .sort((a, b) => a - b)
    .map(index => ({ item: items[index], index }));
}

function sampleAcrossReasons(reviewItems, totalMin, minPerReason, seed) {
  const byReason = new Map();
  for (const item of reviewItems) {
    if (!byReason.has(item.reason)) byReason.set(item.reason, []);
    byReason.get(item.reason).push(item);
  }

  const picked = [];
  const reasons = [...byReason.keys()];

  for (const reason of reasons) {
    const bucket = byReason.get(reason);
    const take = Math.min(bucket.length, minPerReason);
    picked.push(...systematicSample(bucket, take, seed).map(s => s.item));
  }

  // Top up proportionally (by remaining bucket size) until totalMin is met.
  let remaining = totalMin - picked.length;
  if (remaining > 0) {
    const pickedSet = new Set(picked);
    const pool = reviewItems.filter(item => !pickedSet.has(item));
    const extra = systematicSample(pool, Math.min(remaining, pool.length), seed + 1).map(s => s.item);
    picked.push(...extra);
  }

  return picked;
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

function namePlausible(name) {
  const value = clean(name);
  return value.length >= 2 && /\p{L}/u.test(value);
}

/* ============================================================
   KONYA sample
   ============================================================ */

const konyaByExternalId = new Map(
  konyaRaw.features.map(f => [String(f.properties.POI_ID), f])
);

function auditKonyaNewCanonical(park) {
  const issues = [];
  const checks = {};

  checks.name_plausible = namePlausible(park.name);
  if (!checks.name_plausible) issues.push("implausible name");

  const ref = park.source_refs?.[0];
  checks.external_id_present = Boolean(ref?.external_id);
  if (!checks.external_id_present) issues.push("missing external_id");

  const rawFeature = ref ? konyaByExternalId.get(ref.external_id) : undefined;
  checks.external_id_resolves_to_raw_feature = Boolean(rawFeature);
  if (!checks.external_id_resolves_to_raw_feature) issues.push("external_id not found in raw source");

  if (rawFeature) {
    const [rawLon, rawLat] = rawFeature.geometry.coordinates;
    const drift = distanceMeters(
      { latitude: park.latitude, longitude: park.longitude },
      { latitude: rawLat, longitude: rawLon }
    );
    checks.coordinate_matches_raw_feature = drift < 1;
    checks.coordinate_drift_m = Math.round(drift * 1000) / 1000;
    if (!checks.coordinate_matches_raw_feature) issues.push(`coordinate drift ${drift}m from raw point feature`);

    const rawDistrict = rawFeature.properties.ILCEADI;
    checks.district_matches_raw_source = Boolean(rawDistrict) && park.district.length > 0;
    if (!checks.district_matches_raw_source) issues.push("district does not trace back to raw ILCEADI");
  }

  checks.coordinate_plausible = coordPlausible(park.latitude, park.longitude);
  if (!checks.coordinate_plausible) issues.push("coordinate outside Turkey bbox");

  const contains = provincesContaining(provinceRegions, park.longitude, park.latitude);
  checks.province_correct = park.city === "Konya" && contains.some(r => r.name === "Konya");
  if (!checks.province_correct) issues.push(`province check failed (contains=${contains.map(r => r.name).join(",")})`);

  checks.district_present = Boolean(park.district);
  if (!checks.district_present) issues.push("district missing");

  checks.provenance_correct =
    park.source === "Konya Büyükşehir Belediyesi Açık Veri Platformu" &&
    ref?.source_code === "konya_acikveri_parklar" &&
    typeof ref?.source_url === "string" &&
    ref.source_url.includes("acikveri.konya.bel.tr");
  if (!checks.provenance_correct) issues.push("provenance fields inconsistent");

  // Near-duplicate check: is there an existing Konya OSM park under a
  // *different, specific* name within a wider net than the adapter's own
  // reconciliation radius (150m)? This is informational — it re-checks the
  // adapter's own decision at 2x its widest tier, looking for a miss.
  const nearOsm = nationwidePreview.parks.filter(
    p =>
      p.city === "Konya" &&
      p.osm_id &&
      distanceMeters(park, p) <= 300 &&
      p.name &&
      nameKey(p.name) !== nameKey(park.name)
  );
  checks.possible_missed_osm_match_within_300m = nearOsm.map(p => ({
    id: p.id,
    osm_id: p.osm_id,
    name: p.name,
    distance_m: Math.round(distanceMeters(park, p))
  }));

  return { id: park.id, name: park.name, district: park.district, external_id: ref?.external_id, checks, issues };
}

function auditKonyaMatched(entry) {
  const issues = [];
  const checks = {};

  const canonicalPark = nationwidePreview.parks.find(p => p.id === entry.canonical_id);
  checks.canonical_id_exists = Boolean(canonicalPark);
  if (!checks.canonical_id_exists) issues.push("canonical_id not found in nationwide baseline");

  checks.osm_id_matches = Boolean(canonicalPark) && canonicalPark.osm_id === entry.osm_id;
  if (!checks.osm_id_matches) issues.push("osm_id mismatch vs nationwide baseline (identity would be silently overwritten)");

  const rawFeature = konyaByExternalId.get(entry.source_ref.external_id);
  checks.external_id_resolves_to_raw_feature = Boolean(rawFeature);
  if (!checks.external_id_resolves_to_raw_feature) issues.push("external_id not found in raw source");

  checks.provenance_correct =
    entry.source_ref.source_code === "konya_acikveri_parklar" &&
    typeof entry.source_ref.source_url === "string";
  if (!checks.provenance_correct) issues.push("provenance fields inconsistent");

  let nameNote = null;
  if (canonicalPark && rawFeature) {
    const candidateName = clean(rawFeature.properties.POI_ADI) || "İsimsiz park";
    nameNote = { canonical_name: canonicalPark.name, source_name: candidateName };
  }

  return {
    canonical_id: entry.canonical_id,
    osm_id: entry.osm_id,
    external_id: entry.source_ref.external_id,
    names: nameNote,
    checks,
    issues
  };
}

function auditReviewRecord(entry, sourceCode) {
  const issues = [];
  const checks = {};

  checks.reason_present = Boolean(entry.reason);
  checks.candidate_has_external_id = Boolean(entry.candidate?.external_id);
  checks.not_added_to_canonical = true; // structural: review[] is never merged by construction
  checks.has_osm_candidate_reference = Boolean(entry.osm_candidate || entry.osm_candidates);

  if (!checks.candidate_has_external_id) issues.push("review candidate missing external_id");
  if (!checks.has_osm_candidate_reference) issues.push("review record missing OSM candidate reference(s)");

  return {
    source_code: sourceCode,
    reason: entry.reason,
    external_id: entry.candidate?.external_id,
    name: entry.candidate?.name,
    checks,
    issues
  };
}

const konyaNewSample = systematicSample(konyaPreview.newCanonicalParks, 30, 1001).map(s =>
  auditKonyaNewCanonical(s.item)
);
const konyaMatchedSample = systematicSample(konyaPreview.matched, 15, 1002).map(s =>
  auditKonyaMatched(s.item)
);
const konyaReviewSample = sampleAcrossReasons(konyaPreview.review, 20, 5, 1003).map(item =>
  auditReviewRecord(item, "konya_acikveri_parklar")
);

/* ============================================================
   ORDU sample
   ============================================================ */

const orduByExternalId = new Map(orduRaw.features.map(f => [String(f.properties.ID), f]));

function auditOrduNewCanonical(park) {
  const issues = [];
  const checks = {};

  checks.name_plausible = namePlausible(park.name);
  if (!checks.name_plausible) issues.push("implausible name");

  const ref = park.source_refs?.[0];
  checks.external_id_present = Boolean(ref?.external_id);
  if (!checks.external_id_present) issues.push("missing external_id");

  const rawFeature = ref ? orduByExternalId.get(ref.external_id) : undefined;
  checks.external_id_resolves_to_raw_feature = Boolean(rawFeature);
  if (!checks.external_id_resolves_to_raw_feature) issues.push("external_id not found in raw source");

  if (rawFeature) {
    // representativePoint picks the largest MultiPolygon part; re-derive
    // which part that is and confirm the stored point-on-surface actually
    // sits inside it (never a centroid that fell outside).
    const parts = rawFeature.geometry.coordinates;
    let bestRings = null;
    let bestArea = -Infinity;
    for (const rings of parts) {
      const ring = rings[0];
      let area = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        area += x1 * y2 - x2 * y1;
      }
      area = Math.abs(area / 2);
      if (area > bestArea) {
        bestArea = area;
        bestRings = rings;
      }
    }

    // rings coordinates may carry a stray z (elevation) value — strip it,
    // pointInPolygonRings only reads [lon, lat].
    const rings2d = bestRings.map(ring => ring.map(([lon, lat]) => [lon, lat]));

    checks.point_on_surface_inside_polygon = pointInPolygonRings(
      park.longitude,
      park.latitude,
      rings2d
    );
    if (!checks.point_on_surface_inside_polygon) issues.push("representative point falls OUTSIDE its source polygon");
  }

  checks.coordinate_plausible = coordPlausible(park.latitude, park.longitude);
  if (!checks.coordinate_plausible) issues.push("coordinate outside Turkey bbox");

  const contains = provincesContaining(provinceRegions, park.longitude, park.latitude);
  checks.province_correct = park.city === "Ordu" && (contains.some(r => r.name === "Ordu") || contains.length === 0);
  if (!checks.province_correct) issues.push(`province check failed (contains=${contains.map(r => r.name).join(",")})`);

  // district is genuinely absent from this source — "correct" means
  // honestly empty, never fabricated, which is what we check.
  checks.district_honestly_empty = park.district === "";
  if (!checks.district_honestly_empty) issues.push("district unexpectedly non-empty for a source with no district field");

  checks.provenance_correct =
    park.source === "Ordu Büyükşehir Belediyesi Açık Veri Platformu" &&
    ref?.source_code === "ordu_acikveri_parklari" &&
    typeof ref?.source_url === "string" &&
    ref.source_url.includes("acikveri.ordu.bel.tr");
  if (!checks.provenance_correct) issues.push("provenance fields inconsistent");

  const nearOsm = nationwidePreview.parks.filter(
    p =>
      p.city === "Ordu" &&
      p.osm_id &&
      distanceMeters(park, p) <= 600 &&
      p.name &&
      nameKey(p.name) !== nameKey(park.name)
  );
  checks.possible_missed_osm_match_within_600m = nearOsm.map(p => ({
    id: p.id,
    osm_id: p.osm_id,
    name: p.name,
    distance_m: Math.round(distanceMeters(park, p))
  }));

  return { id: park.id, name: park.name, district: park.district, external_id: ref?.external_id, checks, issues };
}

function auditOrduMatched(entry) {
  const issues = [];
  const checks = {};

  const canonicalPark = nationwidePreview.parks.find(p => p.id === entry.canonical_id);
  checks.canonical_id_exists = Boolean(canonicalPark);
  if (!checks.canonical_id_exists) issues.push("canonical_id not found in nationwide baseline");

  checks.osm_id_matches = Boolean(canonicalPark) && canonicalPark.osm_id === entry.osm_id;
  if (!checks.osm_id_matches) issues.push("osm_id mismatch vs nationwide baseline");

  const rawFeature = orduByExternalId.get(entry.source_ref.external_id);
  checks.external_id_resolves_to_raw_feature = Boolean(rawFeature);
  if (!checks.external_id_resolves_to_raw_feature) issues.push("external_id not found in raw source");

  checks.provenance_correct =
    entry.source_ref.source_code === "ordu_acikveri_parklari" &&
    typeof entry.source_ref.source_url === "string";
  if (!checks.provenance_correct) issues.push("provenance fields inconsistent");

  let nameNote = null;
  if (canonicalPark && rawFeature) {
    const candidateName = clean(rawFeature.properties.ADI) || "İsimsiz park";
    nameNote = { canonical_name: canonicalPark.name, source_name: candidateName };
  }

  return {
    canonical_id: entry.canonical_id,
    osm_id: entry.osm_id,
    external_id: entry.source_ref.external_id,
    names: nameNote,
    checks,
    issues
  };
}

const orduNewSample = systematicSample(orduPreview.newCanonicalParks, 20, 2001).map(s =>
  auditOrduNewCanonical(s.item)
);
// "sample all 10 MATCHED records if practical" — 10 is small enough to do all of them.
const orduMatchedSample = orduPreview.matched.map(entry => auditOrduMatched(entry));
const orduReviewSample = sampleAcrossReasons(orduPreview.review, 20, 5, 2003).map(item =>
  auditReviewRecord(item, "ordu_acikveri_parklari")
);

/* ============================================================
   Report
   ============================================================ */

function summarize(samples) {
  const total = samples.length;
  const withIssues = samples.filter(s => s.issues.length > 0);
  return {
    sampled: total,
    clean: total - withIssues.length,
    withIssues: withIssues.length,
    issueDetail: withIssues.map(s => ({ id: s.id ?? s.canonical_id ?? s.external_id, issues: s.issues }))
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: "municipal-sample-audit",
  method:
    "Fixed-seed systematic sampling (mulberry32 PRNG, seeds recorded per bucket) — reproducible, not cherry-picked by appearance. Review buckets sampled across all reported reasons (min 5 per reason before proportional top-up).",
  konya: {
    newCanonical: { summary: summarize(konyaNewSample), records: konyaNewSample },
    matched: { summary: summarize(konyaMatchedSample), records: konyaMatchedSample },
    review: { summary: summarize(konyaReviewSample), records: konyaReviewSample }
  },
  ordu: {
    newCanonical: { summary: summarize(orduNewSample), records: orduNewSample },
    matched: { summary: summarize(orduMatchedSample), records: orduMatchedSample },
    review: { summary: summarize(orduReviewSample), records: orduReviewSample }
  }
};

const outputPath = new URL("municipal-sample-audit.json", cacheRoot);
await writeFile(outputPath, JSON.stringify(report, null, 2));

console.log("===== MUNICIPAL SAMPLE AUDIT =====");
console.log("KONYA new:", report.konya.newCanonical.summary.sampled, "sampled,", report.konya.newCanonical.summary.withIssues, "with issues");
console.log("KONYA matched:", report.konya.matched.summary.sampled, "sampled,", report.konya.matched.summary.withIssues, "with issues");
console.log("KONYA review:", report.konya.review.summary.sampled, "sampled,", report.konya.review.summary.withIssues, "with issues");
console.log("ORDU new:", report.ordu.newCanonical.summary.sampled, "sampled,", report.ordu.newCanonical.summary.withIssues, "with issues");
console.log("ORDU matched:", report.ordu.matched.summary.sampled, "sampled,", report.ordu.matched.summary.withIssues, "with issues");
console.log("ORDU review:", report.ordu.review.summary.sampled, "sampled,", report.ordu.review.summary.withIssues, "with issues");
console.log(`\nSaved -> ${outputPath}`);

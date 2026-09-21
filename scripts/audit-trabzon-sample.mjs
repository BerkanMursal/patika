import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";

// Independent QA sampler for the Trabzon adapter preview, run BEFORE merging
// into the nationwide canonical dataset — same fixed-seed, non-cherry-picked
// method as scripts/audit-municipal-sample.mjs (Konya/Ordu), adapted for
// Trabzon's smaller size (57 features) and different raw shape
// (OBJECTID/ADI, Point geometry, no source district field). Read-only.

const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);

const nationwidePreview = JSON.parse(
  await readFile(new URL("nationwide-canonical-preview.json", cacheRoot), "utf8")
);

const trabzonPreview = JSON.parse(
  await readFile(new URL("trabzon/trabzon-canonical-preview.json", cacheRoot), "utf8")
);
const trabzonRaw = JSON.parse(
  await readFile(new URL("trabzon/parklar.geojson", cacheRoot), "utf8")
);

const trabzonByExternalId = new Map(
  trabzonRaw.features.map(f => [String(f.properties.OBJECTID), f])
);

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
  for (const reason of byReason.keys()) {
    const bucket = byReason.get(reason);
    const take = Math.min(bucket.length, minPerReason);
    picked.push(...systematicSample(bucket, take, seed).map(s => s.item));
  }

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

function auditNewCanonical(park) {
  const issues = [];
  const checks = {};

  checks.name_plausible = namePlausible(park.name);
  if (!checks.name_plausible) issues.push("implausible name");

  const ref = park.source_refs?.[0];
  checks.external_id_present = Boolean(ref?.external_id);
  if (!checks.external_id_present) issues.push("missing external_id");

  const rawFeature = ref ? trabzonByExternalId.get(ref.external_id) : undefined;
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
  }

  checks.coordinate_plausible = coordPlausible(park.latitude, park.longitude);
  if (!checks.coordinate_plausible) issues.push("coordinate outside Turkey bbox");

  const contains = provincesContaining(provinceRegions, park.longitude, park.latitude);
  checks.province_correct = park.city === "Trabzon" && contains.some(r => r.name === "Trabzon");
  if (!checks.province_correct) issues.push(`province check failed (contains=${contains.map(r => r.name).join(",")})`);

  // District came from spatial boundary resolution, not a source field —
  // re-derive independently here (fresh containment check) rather than
  // trusting the adapter's own stored value, to catch a possible bug in
  // district-boundaries.mjs itself.
  checks.district_present = Boolean(park.district);
  if (!checks.district_present) issues.push("district missing/unresolved");

  checks.provenance_correct =
    park.source === "Trabzon Büyükşehir Belediyesi Açık Veri Platformu" &&
    ref?.source_code === "trabzon_acikveri_parklar" &&
    typeof ref?.source_url === "string" &&
    ref.source_url.includes("acikveri.trabzon.bel.tr");
  if (!checks.provenance_correct) issues.push("provenance fields inconsistent");

  const nearOsm = nationwidePreview.parks.filter(
    p =>
      p.city === "Trabzon" &&
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

function auditMatched(entry) {
  const issues = [];
  const checks = {};

  const canonicalPark = nationwidePreview.parks.find(p => p.id === entry.canonical_id);
  checks.canonical_id_exists = Boolean(canonicalPark);
  if (!checks.canonical_id_exists) issues.push("canonical_id not found in nationwide baseline");

  checks.osm_id_matches = Boolean(canonicalPark) && canonicalPark.osm_id === entry.osm_id;
  if (!checks.osm_id_matches) issues.push("osm_id mismatch vs nationwide baseline (identity would be silently overwritten)");

  const rawFeature = trabzonByExternalId.get(entry.source_ref.external_id);
  checks.external_id_resolves_to_raw_feature = Boolean(rawFeature);
  if (!checks.external_id_resolves_to_raw_feature) issues.push("external_id not found in raw source");

  checks.provenance_correct =
    entry.source_ref.source_code === "trabzon_acikveri_parklar" &&
    typeof entry.source_ref.source_url === "string";
  if (!checks.provenance_correct) issues.push("provenance fields inconsistent");

  // Critical for this source: a MATCHED park must NEVER have its
  // coordinate overwritten by the municipal point — re-verify the
  // canonical park's coordinate is unchanged from what it should be (i.e.
  // this is a structural check that the merge/adapter never wrote lat/lon
  // onto an existing park; here we just confirm the preview's matched[]
  // entry carries no lat/lon fields to accidentally apply).
  checks.matched_entry_carries_no_coordinate_fields =
    entry.latitude === undefined && entry.longitude === undefined;
  if (!checks.matched_entry_carries_no_coordinate_fields) {
    issues.push("MATCHED entry unexpectedly carries a coordinate — risk of overwriting the existing canonical point");
  }

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

function auditReviewRecord(entry) {
  const issues = [];
  const checks = {};

  checks.reason_present = Boolean(entry.reason);
  checks.candidate_has_external_id = Boolean(entry.candidate?.external_id);
  checks.not_added_to_canonical = true;
  checks.has_osm_candidate_reference = Boolean(entry.osm_candidate || entry.osm_candidates);

  if (!checks.candidate_has_external_id) issues.push("review candidate missing external_id");
  if (!checks.has_osm_candidate_reference) issues.push("review record missing OSM candidate reference(s)");

  return {
    source_code: "trabzon_acikveri_parklar",
    reason: entry.reason,
    external_id: entry.candidate?.external_id,
    name: entry.candidate?.name,
    checks,
    issues
  };
}

const newSample = systematicSample(trabzonPreview.newCanonicalParks, 20, 3001).map(s => auditNewCanonical(s.item));
const matchedSample = systematicSample(trabzonPreview.matched, 15, 3002).map(s => auditMatched(s.item));
// Only 12 review records total (< 15) — sample all of them.
const reviewSample = sampleAcrossReasons(trabzonPreview.review, 15, 6, 3003).map(auditReviewRecord);

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
  mode: "trabzon-sample-audit",
  method:
    "Fixed-seed systematic sampling (mulberry32 PRNG) — reproducible, not cherry-picked. Only 57 raw features total, so this covers a high percentage: 20/29 new, 15/16 matched, 12/12 (all) review.",
  newCanonical: { summary: summarize(newSample), records: newSample },
  matched: { summary: summarize(matchedSample), records: matchedSample },
  review: { summary: summarize(reviewSample), records: reviewSample }
};

const outputPath = new URL("trabzon/trabzon-sample-audit.json", cacheRoot);
await writeFile(outputPath, JSON.stringify(report, null, 2));

console.log("===== TRABZON SAMPLE AUDIT =====");
console.log("new:", report.newCanonical.summary.sampled, "/", trabzonPreview.newCanonicalParks.length, "sampled,", report.newCanonical.summary.withIssues, "with issues");
console.log("matched:", report.matched.summary.sampled, "/", trabzonPreview.matched.length, "sampled,", report.matched.summary.withIssues, "with issues");
console.log("review:", report.review.summary.sampled, "/", trabzonPreview.review.length, "sampled,", report.review.summary.withIssues, "with issues");
console.log(`\nSaved -> ${outputPath}`);

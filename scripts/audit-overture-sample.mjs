import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";

// Independent QA sampler for the Overture Turkey gap-analysis preview, run
// BEFORE any future merge is even considered — same fixed-seed, non-cherry-
// picked method as the Konya/Ordu/Trabzon sample auditors. Read-only.

const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);

const nationwidePreview = JSON.parse(await readFile(new URL("nationwide-canonical-preview.json", cacheRoot), "utf8"));
const nwById = new Map(nationwidePreview.parks.map(p => [p.id, p]));

const gapPreview = JSON.parse(await readFile(new URL("overture/overture-turkey-gap-preview.json", cacheRoot), "utf8"));

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
  return indices.slice(0, count).sort((a, b) => a - b).map(index => ({ item: items[index], index }));
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
    picked.push(...systematicSample(bucket, Math.min(bucket.length, minPerReason), seed).map(s => s.item));
  }
  let remaining = totalMin - picked.length;
  if (remaining > 0) {
    const pickedSet = new Set(picked);
    const pool = reviewItems.filter(item => !pickedSet.has(item));
    picked.push(...systematicSample(pool, Math.min(remaining, pool.length), seed + 1).map(s => s.item));
  }
  return picked;
}

const TURKEY_BBOX = { minLat: 35, maxLat: 43, minLon: 25, maxLon: 45 };
function coordPlausible(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= TURKEY_BBOX.minLat && lat <= TURKEY_BBOX.maxLat && lon >= TURKEY_BBOX.minLon && lon <= TURKEY_BBOX.maxLon;
}
function namePlausible(name) {
  const value = clean(name);
  return value.length === 0 || (/\p{L}/u.test(value) && value.length >= 2); // empty name is honest (Overture often has none), not implausible
}

function auditStrongNewCandidate(c) {
  const issues = [];
  const checks = {};

  checks.taxonomy_is_park = c.taxonomy_primary === "park";
  if (!checks.taxonomy_is_park) issues.push(`taxonomy_primary is '${c.taxonomy_primary}', not 'park'`);

  checks.stable_id_present = Boolean(c.overture_id) && /^[0-9a-f-]{20,}$/i.test(c.overture_id.replace(/^overture:place:/, ""));
  if (!checks.stable_id_present) issues.push("overture_id missing or not GERS-id-shaped");

  checks.coordinate_plausible = coordPlausible(c.latitude, c.longitude);
  if (!checks.coordinate_plausible) issues.push("coordinate outside Turkey bbox");

  const contains = provincesContaining(provinceRegions, c.longitude, c.latitude);
  checks.province_correct = contains.some(r => r.name === c.province);
  if (!checks.province_correct) issues.push(`province check failed (contains=${contains.map(r => r.name).join(",")}, claimed=${c.province})`);

  checks.name_plausible = namePlausible(c.name);
  if (!checks.name_plausible) issues.push("implausible name");

  checks.provenance_retained = Array.isArray(c.sources) && c.sources.length > 0 && c.sources.every(s => s.provider || s.dataset);
  if (!checks.provenance_retained) issues.push("no provenance (sources[]) retained");

  // No obvious missed nearby canonical match — re-check independently at a
  // wider radius than the adapter's own tiers (2x), same "second look" QA
  // pattern used for Konya/Ordu/Trabzon.
  const wideRadius = 300;
  const nearCanonical = nationwidePreview.parks.filter(
    p => p.city === c.province && distanceMeters(c, p) <= wideRadius && p.name && nameKey(p.name) !== nameKey(c.name)
  );
  checks.possible_missed_canonical_match_within_300m = nearCanonical.map(p => ({
    id: p.id, osm_id: p.osm_id, name: p.name, source: p.source, distance_m: Math.round(distanceMeters(c, p))
  }));

  return { overture_id: c.overture_id, name: c.name, province: c.province, district: c.district, checks, issues };
}

function auditMatchedExisting(m) {
  const issues = [];
  const checks = {};

  const canonicalPark = nwById.get(m.canonical_id);
  checks.canonical_id_exists = Boolean(canonicalPark);
  if (!checks.canonical_id_exists) issues.push("canonical_id not found in nationwide preview");

  checks.osm_id_matches_if_present = !m.canonical_osm_id || (canonicalPark && canonicalPark.osm_id === m.canonical_osm_id);
  if (!checks.osm_id_matches_if_present) issues.push("recorded canonical_osm_id does not match live canonical park's osm_id");

  checks.distance_recorded_and_reasonable = Number.isFinite(m.distance_m) && m.distance_m <= 150;
  if (!checks.distance_recorded_and_reasonable) issues.push(`distance_m (${m.distance_m}) outside expected matching tier`);

  return { overture_id: m.overture_id, canonical_id: m.canonical_id, overture_name: m.overture_name, canonical_name: m.canonical_name, distance_m: m.distance_m, checks, issues };
}

function auditReviewRecord(entry) {
  const issues = [];
  const checks = {};
  checks.reason_present = Boolean(entry.reason);
  checks.candidate_has_id = Boolean(entry.candidate?.id);
  checks.has_canonical_reference = Boolean(entry.canonical_candidate || entry.canonical_candidates);
  if (!checks.candidate_has_id) issues.push("review candidate missing overture id");
  if (!checks.has_canonical_reference) issues.push("review record missing canonical reference(s)");
  return { reason: entry.reason, overture_id: entry.candidate?.id, name: entry.candidate?.name, province: entry.candidate?.province, checks, issues };
}

const strongSample = systematicSample(gapPreview.strongNewCandidates, 30, 4001).map(s => auditStrongNewCandidate(s.item));
const matchedSample = systematicSample(gapPreview.matchedExisting, 20, 4002).map(s => auditMatchedExisting(s.item));
const reviewSample = sampleAcrossReasons(gapPreview.review, 20, 7, 4003).map(auditReviewRecord);

function summarize(samples) {
  const withIssues = samples.filter(s => s.issues.length > 0);
  return { sampled: samples.length, clean: samples.length - withIssues.length, withIssues: withIssues.length, issueDetail: withIssues.map(s => ({ id: s.overture_id, issues: s.issues })) };
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: "overture-sample-audit",
  method: "Fixed-seed systematic sampling (mulberry32 PRNG) — reproducible, not cherry-picked. Review sampled across all reported reasons.",
  strongNewCandidate: { summary: summarize(strongSample), records: strongSample },
  matchedExisting: { summary: summarize(matchedSample), records: matchedSample },
  review: { summary: summarize(reviewSample), records: reviewSample }
};

const outputPath = new URL("overture/overture-sample-audit.json", cacheRoot);
await writeFile(outputPath, JSON.stringify(report, null, 2));

console.log("===== OVERTURE SAMPLE AUDIT =====");
console.log("STRONG_NEW_CANDIDATE:", report.strongNewCandidate.summary.sampled, "sampled,", report.strongNewCandidate.summary.withIssues, "with issues");
console.log("MATCHED_EXISTING:", report.matchedExisting.summary.sampled, "sampled,", report.matchedExisting.summary.withIssues, "with issues");
console.log("REVIEW:", report.review.summary.sampled, "sampled,", report.review.summary.withIssues, "with issues");
console.log(`\nSaved -> ${outputPath}`);

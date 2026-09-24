import { readFile, writeFile } from "node:fs/promises";
import { clean, nameKey, distanceMeters } from "./park-enrichment.mjs";
import { pointInPolygonRings } from "./polygon-geometry.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";

// Config-driven, read-only, fixed-seed sample audit for engine-run municipal
// previews (Kayseri/Van and any future source). Up to 20 NEW_CANONICAL,
// 15 MATCHED, 15 REVIEW per source (all if fewer). Also runs full-population
// checks. Never writes to previews / nationwide file / DB.
//   node scripts/audit-municipal-generic-sample.mjs <source_code> [seed]

const sourceCode = process.argv[2];
const seed = Number(process.argv[3] ?? 4242);
const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const { configs } = JSON.parse(await readFile(new URL("../data/municipal-ingestion-configs.json", import.meta.url), "utf8"));
const config = configs.find(c => c.source_code === sourceCode);
const preview = JSON.parse(await readFile(new URL(`${config.cache_dir}/${sourceCode}-generic-preview.json`, cacheRoot), "utf8"));
const raw = JSON.parse(await readFile(new URL(`${config.cache_dir}/${config.raw_filename}`, cacheRoot), "utf8"));
const nationwide = JSON.parse(await readFile(new URL("nationwide-canonical-preview.json", cacheRoot), "utf8"));
const provinceRegions = await loadProvinceRegions(new URL("../data/provinces.geojson", import.meta.url));
const parkById = new Map(nationwide.parks.map(p => [p.id, p]));
const rawById = new Map(raw.features.map(f => [String(f.properties[config.id_field]), f]));

function mulberry32(s) { let a = s; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sample(items, count, sd) {
  if (items.length <= count) return items.slice();
  const rng = mulberry32(sd); const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, count).sort((a, b) => a - b).map(i => items[i]);
}
// review: stratified across reasons so every reason appears, topped up to 15
function sampleReview(items, total, sd) {
  const by = new Map(); for (const r of items) { if (!by.has(r.reason)) by.set(r.reason, []); by.get(r.reason).push(r); }
  const picked = []; for (const [, b] of by) picked.push(...sample(b, Math.min(b.length, 3), sd));
  const rest = items.filter(r => !picked.includes(r));
  picked.push(...sample(rest, Math.max(0, total - picked.length), sd + 1));
  return picked.slice(0, Math.max(total, by.size * 3 > total ? picked.length : total));
}

// independent raw-derived representative coordinate check
function rawGeomContains(feature, lat, lon) {
  const g = feature.geometry;
  if (g.type === "Point") return distanceMeters({ latitude: lat, longitude: lon }, { latitude: g.coordinates[1], longitude: g.coordinates[0] }) < 0.5;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some(rings => pointInPolygonRings(lon, lat, rings));
}

const containsParkWord = t => /(?<![\p{L}\p{N}])park(lar)?[ıi]?(?![\p{L}\p{N}])/u.test(clean(t).toLocaleLowerCase("tr"));
const parkTaxonomyOk = f => config.taxonomy_field
  ? (config.allowed_taxonomy_values ?? []).includes(f.properties[config.taxonomy_field])
  : config.taxonomy_rule === "name_contains_park_word" ? containsParkWord(f.properties[config.name_field]) : true;
const nearby = (lat, lon, r, excludeId) => nationwide.parks
  .filter(p => p.id !== excludeId && p.city === config.province)
  .map(p => ({ id: p.id, name: p.name, osm: !!p.osm_id, d: Math.round(distanceMeters({ latitude: lat, longitude: lon }, p)) }))
  .filter(p => p.d <= r).sort((a, b) => a.d - b.d).slice(0, 4);

function common(externalId, lat, lon, name, ref) {
  const issues = []; const f = rawById.get(String(externalId));
  if (!f) issues.push("external_id not in raw source");
  else {
    if (String(f.properties[config.id_field]) !== String(externalId)) issues.push("id mismatch");
    if (!parkTaxonomyOk(f)) issues.push("raw record fails PARK taxonomy");
    if (clean(f.properties[config.name_field]) !== clean(name) && !(name === "İsimsiz park")) issues.push("name != raw name");
    if (!rawGeomContains(f, lat, lon)) issues.push("coordinate not derivable from raw geometry");
  }
  const prov = provincesContaining(provinceRegions, lon, lat);
  if (!prov.some(r => r.name === config.province)) issues.push("outside province polygon (nearest fallback?)");
  if (ref && (ref.source_code !== sourceCode || String(ref.external_id) !== String(externalId))) issues.push("source ref mismatch");
  return issues;
}

const newRecs = sample(preview.newCanonicalParks, 20, seed + 1).map(p => {
  const issues = common(p.source_refs[0].external_id, p.latitude, p.longitude, p.name, p.source_refs[0]);
  if (p.source_refs.length !== 1) issues.push("source_refs != 1");
  if (p.osm_id !== null) issues.push("osm_id not null");
  if (!p.district) issues.push("district missing");
  const near = nearby(p.latitude, p.longitude, 300, p.id);
  return { kind: "NEW", external_id: p.source_refs[0].external_id, name: p.name, district: p.district, issues, nearby_300m: near };
});
const matchedRecs = sample(preview.matched, 15, seed + 2).map(m => {
  const canon = parkById.get(m.canonical_id); const issues = [];
  if (!canon) issues.push("canonical target missing");
  else {
    if (canon.osm_id !== m.osm_id) issues.push("osm_id mismatch");
    if (canon.city !== config.province) issues.push("canonical target in other province");
  }
  const f = rawById.get(String(m.source_ref.external_id));
  if (!f) issues.push("external_id not in raw source"); else if (!parkTaxonomyOk(f)) issues.push("raw record fails PARK taxonomy");
  if (m.source_ref.source_code !== sourceCode) issues.push("source ref code");
  const fp = f && (f.geometry.type === "Point" ? { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] } : null);
  const d = canon && f ? (fp ? Math.round(distanceMeters(fp, canon)) : "polygon") : null;
  const others = canon ? nearby(canon.latitude, canon.longitude, 150, canon.id).length : null;
  return { kind: "MATCHED", external_id: m.source_ref.external_id, source_name: f?.properties[config.name_field], canonical_name: canon?.name, dist_to_canonical_m: d, other_canonical_within_150m_of_target: others, issues };
});
const reviewRecs = sampleReview(preview.review, 15, seed + 3).map(r => {
  const c = r.candidate; const issues = common(c.external_id, c.latitude, c.longitude, c.name, null);
  const rawOsm = r.osm_candidates ?? (r.osm_candidate ? [r.osm_candidate] : []);
  const cands = rawOsm.map(o => ({ name: o.name, d: Math.round(distanceMeters(c, parkById.get(o.id))) }));
  if (r.reason === "possible_duplicate_within_source") {
    for (const oid of r.other_candidates_targeting_same_park ?? []) {
      const of = rawById.get(String(oid)); if (!of) { issues.push("duplicate-cluster peer missing in raw"); continue; }
      const [olon, olat] = of.geometry.type === "Point" ? of.geometry.coordinates : [null, null];
      cands.push({ name: `(same-source peer ${oid}) ${of.properties[config.name_field]}`, d: olat === null ? null : Math.round(distanceMeters(c, { latitude: olat, longitude: olon })) });
    }
  }
  return { kind: "REVIEW:" + r.reason, external_id: c.external_id, name: c.name, district: c.district, osm_candidates: cands, issues };
});

// ---- full-population checks
const pop = { newWithIssues: 0, matchedWithIssues: 0, reviewWithIssues: 0 };
const districtDist = {};
for (const p of preview.newCanonicalParks) if (common(p.source_refs[0].external_id, p.latitude, p.longitude, p.name, p.source_refs[0]).length) pop.newWithIssues++;
for (const p of preview.newCanonicalParks) districtDist[p.district] = (districtDist[p.district] ?? 0) + 1;
for (const r of preview.review) if (common(r.candidate.external_id, r.candidate.latitude, r.candidate.longitude, r.candidate.name, null).length) pop.reviewWithIssues++;
const accountedIds = [...preview.newCanonicalParks.map(p => p.source_refs[0].external_id), ...preview.matched.map(m => m.source_ref.external_id), ...preview.review.map(r => r.candidate.external_id)];
pop.accounted = accountedIds.length; pop.accountedUnique = new Set(accountedIds).size;
pop.rejectedIds = preview.rejectedNonPark.length;
pop.rejectedActuallyPass = preview.rejectedNonPark.filter(r => parkTaxonomyOk(rawById.get(r.external_id))).length;
pop.rawAll = raw.features.length; pop.rawUniqueIds = rawById.size;
pop.newDistricts = districtDist;

const explicitIds = process.argv.slice(4).map(String);
const explicitRecs = explicitIds.map(id => {
  const r = preview.review.find(x => String(x.candidate.external_id) === id);
  const inNew = preview.newCanonicalParks.some(p => String(p.source_refs[0].external_id) === id);
  const inMatched = preview.matched.some(m => String(m.source_ref.external_id) === id);
  const c = r?.candidate;
  const issues = c ? common(c.external_id, c.latitude, c.longitude, c.name, null) : ["explicit id not in review"];
  if (inNew || inMatched) issues.push("explicit id still NEW/MATCHED");
  if (r && r.reason !== "possible_match_outside_primary_radius") issues.push("reason != possible_match_outside_primary_radius");
  if (r && !r.extended_radius_evidence) issues.push("no extended_radius_evidence");
  const canonHas = nationwide.parks.some(p => (p.source_refs ?? []).some(x => x.source_code === sourceCode && String(x.external_id) === id));
  if (canonHas) issues.push("still present as canonical source ref");
  return { kind: "EXPLICIT", external_id: id, name: c?.name, classification: r?.reason ?? (inNew ? "NEW" : inMatched ? "MATCHED" : "?"), osm_candidate: r?.osm_candidate, evidence: r?.extended_radius_evidence, issues };
});
const all = [...newRecs, ...matchedRecs, ...reviewRecs, ...explicitRecs];
const report = { sourceCode, seed, sampled: { new: newRecs.length, matched: matchedRecs.length, review: reviewRecs.length }, explicit: explicitRecs, sampleRecordsWithIssues: all.filter(r => r.issues.length).length, population: pop, newRecs, matchedRecs, reviewRecs };
await writeFile(new URL(`${config.cache_dir}/${sourceCode}-sample-audit.json`, cacheRoot), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sourceCode, sampled: report.sampled, explicit: explicitRecs, sampleRecordsWithIssues: report.sampleRecordsWithIssues, population: pop }, null, 1));

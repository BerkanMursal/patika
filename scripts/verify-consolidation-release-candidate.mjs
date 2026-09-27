import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadProvinceRegions, officialProvinceNames } from "./province-boundaries.mjs";

// Independent release-candidate verifier for consolidation + taxonomy gate + review resolution.
// Recomputes everything from the files on disk (never from a producing script's self-report):
// global canonical invariants, OSM deterministic ids (re-derived from osm_id), untouched parks,
// alias/tombstone manifest integrity and per-source source-ref conservation across
// canonical / review backlog / taxonomy review queue / non-park ledgers.
//   node scripts/verify-consolidation-release-candidate.mjs [--dir=ordu-consolidation/final]   (rel .cache)
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
const argv = process.argv.slice(2), val = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const dir = (val("dir") ?? "ordu-consolidation/final").replace(/\/?$/, "/");
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const B = await J("nationwide-canonical-preview.json"), backlog = await J("municipal-review-backlog.json");
const A = await J(`${dir}final-canonical-preview.json`), M = await J(`${dir}canonical-alias-manifest.json`);
const Q = await J(`${dir}taxonomy-review-queue.json`), R = await J(`${dir}review-resolution/resolution.json`);
const consolidationLifecycle = await J("ordu-consolidation/lifecycle.json");
const official = officialProvinceNames(await loadProvinceRegions(new URL("../data/provinces.geojson", import.meta.url)));
function deterministicUuid(value) { // identical to build-nationwide-pbf-baseline.mjs
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-");
}
const key = r => `${r.source_code}:${r.external_id}`;

/* ---------- global canonical invariants ---------- */
const ids = new Set(), osm = new Set(), refLoc = new Map();
let dupId = 0, dupOsm = 0, dupRef = 0, badCoord = 0, badProv = 0, osmIdNotDeterministic = 0;
for (const p of A.parks) {
  if (ids.has(p.id)) dupId++; ids.add(p.id);
  if (p.osm_id) { if (osm.has(p.osm_id)) dupOsm++; osm.add(p.osm_id); if (p.id !== deterministicUuid(`patika-osm:${p.osm_id}`)) osmIdNotDeterministic++; }
  for (const r of p.source_refs ?? []) { if (refLoc.has(key(r))) dupRef++; refLoc.set(key(r), p.id); }
  if (!(Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && p.latitude >= 35 && p.latitude <= 43 && p.longitude >= 25 && p.longitude <= 45)) badCoord++;
  if (!official.has(p.city)) badProv++;
}

/* ---------- alias / tombstone manifest ---------- */
const E = M.entries, retiredIds = E.map(e => e.retired_canonical_id), retired = new Set(retiredIds);
const aliasOf = new Map(E.filter(e => e.lifecycle_action === "ALIAS_REDIRECT").map(e => [e.retired_canonical_id, e.survivor_canonical_id]));
let cycles = 0, chains = 0;
for (const start of aliasOf.keys()) {
  const seen = new Set([start]); let id = aliasOf.get(start), hops = 1;
  while (aliasOf.has(id)) { if (seen.has(id)) { cycles++; break; } seen.add(id); id = aliasOf.get(id); hops++; }
  if (hops > 1) chains++;
}
const aById = new Map(A.parks.map(p => [p.id, p]));
const queueKeys = new Set(Q.review_records.map(r => key(r.source_ref))), ledgerKeys = new Set(Q.non_park_ledger.map(r => key(r.source_ref)));
const alias = {
  entries: E.length, by_action: E.reduce((o, e) => (o[e.lifecycle_action] = (o[e.lifecycle_action] ?? 0) + 1, o), {}),
  duplicate_retired_id: retiredIds.length - retired.size,
  self_alias: [...aliasOf].filter(([a, b]) => a === b).length,
  missing_survivor: [...aliasOf.values()].filter(s => !aById.has(s)).length,
  alias_cycles: cycles, two_step_chains: chains,
  retired_id_still_live: retiredIds.filter(id => aById.has(id)).length,
  retired_id_unknown_in_base: retiredIds.filter(id => !B.parks.some(p => p.id === id)).length,
  consolidation_retired_ids_missing_from_manifest: consolidationLifecycle.retired.filter(l => !retired.has(l.old_canonical_id)).length,
  alias_refs_not_on_survivor: E.filter(e => e.lifecycle_action === "ALIAS_REDIRECT").flatMap(e => e.source_refs_preserved.filter(r => refLoc.get(key(r)) !== e.survivor_canonical_id)).length,
  tombstone_refs_not_in_queue_or_ledger: E.filter(e => e.lifecycle_action !== "ALIAS_REDIRECT").flatMap(e => e.source_refs_preserved.filter(r => !queueKeys.has(key(r)) && !ledgerKeys.has(key(r)))).length,
  refs_preserved_total: E.reduce((n, e) => n + e.source_refs_preserved.length, 0)
};

/* ---------- base parks: missing / mutated ---------- */
let missingNotRetired = 0, identityMutated = 0, baseRefsDropped = 0, unrelatedMutated = 0, refOnlyChanged = 0, osmIdChanged = 0;
const identity = p => JSON.stringify([p.osm_id, p.name, p.city, p.district, p.latitude, p.longitude]);
const withoutRefs = p => { const { source_refs, provenance_metadata, ...rest } = p; return JSON.stringify(rest); };
for (const b of B.parks) {
  const a = aById.get(b.id);
  if (!a) { if (!retired.has(b.id)) missingNotRetired++; continue; }
  if (a.osm_id !== b.osm_id) osmIdChanged++;
  if (identity(a) !== identity(b)) identityMutated++;
  const had = (b.source_refs ?? []).map(key), have = new Set((a.source_refs ?? []).map(key));
  if (!had.every(k => have.has(k))) baseRefsDropped++;
  const refsChanged = JSON.stringify(a.source_refs ?? []) !== JSON.stringify(b.source_refs ?? []);
  if (!refsChanged && JSON.stringify(a) !== JSON.stringify(b)) unrelatedMutated++;
  if (refsChanged && withoutRefs(a) !== withoutRefs(b)) unrelatedMutated++;   // only refs (+ physical-park provenance) may change
  if (refsChanged) refOnlyChanged++;
}

/* ---------- source-ref conservation, per source ---------- */
const resByKey = new Map(R.records.map(r => [`${r.source_code}:${r.source_external_id}`, r]));
const baseRef = new Map(); for (const p of B.parks) for (const r of p.source_refs ?? []) baseRef.set(key(r), p.id);
const reviewKeys = new Set(backlog.records.map(key));
const sources = [...new Set([...[...baseRef.keys()].map(k => k.split(":")[0]), ...backlog.records.map(r => r.source_code)])].sort();
const perSource = {};
let lostTotal = 0, multiLocated = 0;
for (const sc of sources) {
  const o = { canonical_refs_before: 0, canonical_refs_after: 0, base_refs_still_in_canonical: 0, base_refs_moved_to_taxonomy_review: 0, base_refs_moved_to_non_park_ledger: 0, attached_through_review_resolution: 0, review_records_before: 0, review_kept: 0, review_rejected_non_park: 0, lost_refs: 0 };
  for (const [k] of baseRef) if (k.startsWith(sc + ":")) {
    o.canonical_refs_before++;
    const locs = [refLoc.has(k), queueKeys.has(k), ledgerKeys.has(k)].filter(Boolean).length;
    if (locs > 1) multiLocated++;
    if (refLoc.has(k)) o.base_refs_still_in_canonical++; else if (queueKeys.has(k)) o.base_refs_moved_to_taxonomy_review++; else if (ledgerKeys.has(k)) o.base_refs_moved_to_non_park_ledger++; else o.lost_refs++;
  }
  for (const k of reviewKeys) if (k.startsWith(sc + ":")) {
    o.review_records_before++;
    const out = resByKey.get(k)?.proposed_outcome;
    if (refLoc.has(k)) { o.attached_through_review_resolution++; if (!["MATCH_EXISTING", "NEW_CANONICAL_SAFE", "REJECT_DUPLICATE"].includes(out)) o.lost_refs++; }
    else if (out === "KEEP_REVIEW") o.review_kept++;
    else if (out === "REJECT_NON_PARK") o.review_rejected_non_park++;
    else o.lost_refs++;   // resolved as attached but not found in canonical
  }
  for (const [k] of refLoc) if (k.startsWith(sc + ":")) o.canonical_refs_after++;
  lostTotal += o.lost_refs; perSource[sc] = o;
}
const unexplainedNewRefs = [...refLoc.keys()].filter(k => !baseRef.has(k) && !reviewKeys.has(k)).length;

const out = {
  canonical: { base: B.parks.length, final: A.parks.length, delta: A.parks.length - B.parks.length, osm_backed_base: B.parks.filter(p => p.osm_id).length, osm_backed_final: A.parks.filter(p => p.osm_id).length },
  invariants: { duplicate_canonical_id: dupId, duplicate_osm_id: dupOsm, duplicate_source_ref: dupRef, invalid_coordinates: badCoord, province_outside_official_81: badProv,
    osm_deterministic_id_changes: osmIdChanged + osmIdNotDeterministic, base_parks_missing_and_not_retired: missingNotRetired, base_identity_fields_mutated: identityMutated,
    mutated_unrelated_canonical_parks: unrelatedMutated, base_parks_dropping_refs: baseRefsDropped, lost_source_refs: lostTotal, refs_in_more_than_one_location: multiLocated, unexplained_new_refs: unexplainedNewRefs },
  parks_with_refs_appended: refOnlyChanged,
  alias, source_refs_per_source: perSource,
  final_review_backlog: { keep_review: R.records.filter(r => r.proposed_outcome === "KEEP_REVIEW").length, taxonomy_review_records: Q.review_records.length, taxonomy_review_clusters: new Set(Q.review_records.map(r => r.cluster_id)).size, total_records: R.records.filter(r => r.proposed_outcome === "KEEP_REVIEW").length + Q.review_records.length },
  real_files_unchanged_counts: { canonical: B.parks.length, backlog: backlog.records.length }
};
await writeFile(new URL(`${dir}release-candidate-verification.json`, cache), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));

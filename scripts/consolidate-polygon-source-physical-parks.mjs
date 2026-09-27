import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "./park-enrichment.mjs";
import { nameFlags, coreTokens } from "./review-name-evidence.mjs";
import { loadProvinceRegions, officialProvinceNames } from "./province-boundaries.mjs";

// Generic PHYSICAL-PARK consolidation PREVIEW for a polygon municipal source.
//   ONE PHYSICAL PARK -> ONE CANONICAL PARK -> MANY source refs / polygons.
// Reads the inventory/pair evidence written by analyze-polygon-source-inventory.mjs,
// clusters source records by polygon continuity + same meaningful name + same
// district, applies the survivor policy to already-accepted canonicals, and
// rebuilds the source's contribution from a CLEAN pre-source baseline into a
// SEPARATE preview file. Never writes the real canonical preview or a DB.
//   node scripts/consolidate-polygon-source-physical-parks.mjs <source_code>
const sc = process.argv[2] ?? "ordu_acikveri_parklari";
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const cfg = await J("../../physical-park-consolidation-config.json");
const inv = await J("ordu-consolidation/inventory.json");
const pairs = await J("ordu-consolidation/pairs.json");
const canonical = await J("nationwide-canonical-preview.json");
// analysis-only overrides (sensitivity runs): PPC_LINK_GAP / PPC_GRAY_MAX / PPC_NO_WRITE
if (process.env.PPC_LINK_GAP) cfg.link_gap_m = Number(process.env.PPC_LINK_GAP);
if (process.env.PPC_GRAY_MAX) cfg.gray_zone_max_m = Number(process.env.PPC_GRAY_MAX);
const NO_WRITE = !!process.env.PPC_NO_WRITE;
const write = (...a) => NO_WRITE ? Promise.resolve() : writeFile(...a);
const layerField = cfg.sources[sc]?.layer_field;
const NONPARK = new RegExp(cfg.non_park_keywords, "iu");
const parkWord = t => /(?<![\p{L}\p{N}])park(lar)?[ıi]?(?![\p{L}\p{N}])/u.test(String(t ?? "").toLocaleLowerCase("tr"));

/* ---------- records ---------- */
const rawLayer = new Map();
{ const { configs } = await J("../../municipal-ingestion-configs.json"); const c = configs.find(x => x.source_code === sc);
  for (const f of (await J(`${c.cache_dir}/${c.raw_filename}`)).features) { const id = f.properties?.[c.id_field]; if (id !== null && id !== undefined) rawLayer.set(String(id), layerField ? f.properties[layerField] : null); } }
const R = new Map(inv.records.map(r => [r.id, { ...r, layer: rawLayer.get(r.id) ?? null }]));
const lev = (a, b) => { const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 0; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]); return 1 - dp[a.length][b.length] / Math.max(a.length, b.length, 1); };
const districtKeys = inv.district_names;
for (const r of R.values()) {
  const f = nameFlags(r.name);
  const core = coreTokens(r.name).filter(t => !districtKeys.some(d => lev(t, d) >= cfg.district_name_similarity));
  r.name_class = f.placeholder ? "placeholder" : f.generic ? "generic" : core.length === 0 ? "district_only" : "specific";
  r.strict = r.name_class !== "specific";
  r.non_park = (r.layer && NONPARK.test(String(r.layer))) || (!parkWord(r.name) && NONPARK.test(r.name));
}

/* ---------- edges ---------- */
const parent = new Map([...R.keys()].map(k => [k, k]));
const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
const links = [], gray = [], conflicts = [];
for (const p of pairs) {
  const a = R.get(p.a), b = R.get(p.b);
  if (a.non_park || b.non_park) continue;
  const sameDistrict = a.district && b.district ? a.district === b.district : true;
  if (!sameDistrict) continue;
  if (!p.name_evidence) { if (Math.max(p.overlap_fraction_a, p.overlap_fraction_b) >= cfg.different_name_overlap_ambiguity_fraction) conflicts.push(p); continue; }
  const limit = a.strict || b.strict ? cfg.generic_link_gap_m : cfg.link_gap_m;
  if (p.intersects || p.touches || p.boundary_gap_m <= limit) { links.push(p); union(p.a, p.b); }
  else if (p.boundary_gap_m <= cfg.gray_zone_max_m) gray.push(p);
}
/* ---------- components + groups ---------- */
const comps = new Map();
for (const r of R.values()) { const c = find(r.id); if (!comps.has(c)) comps.set(c, []); comps.get(c).push(r); }
const compOf = new Map(); for (const [c, ms] of comps) for (const m of ms) compOf.set(m.id, c);
const gparent = new Map([...comps.keys()].map(k => [k, k])), gfind = k => { while (gparent.get(k) !== k) { gparent.set(k, gparent.get(gparent.get(k))); k = gparent.get(k); } return k; };
const conflictComps = new Set();
for (const g of gray) { const x = gfind(compOf.get(g.a)), y = gfind(compOf.get(g.b)); if (x !== y) gparent.set(x, y); }
for (const c of conflicts) { conflictComps.add(compOf.get(c.a)); conflictComps.add(compOf.get(c.b)); }
const groups = new Map();
for (const c of comps.keys()) { const g = gfind(c); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }

const clusters = [];
let cid = 0;
for (const [g, cs] of groups) {
  const ambiguous = cs.length > 1 || cs.some(c => conflictComps.has(c));
  for (const c of cs) {
    const ms = comps.get(c).sort((a, b) => Number(a.id) - Number(b.id));
    const accOsm = [...new Set(ms.filter(m => m.status === "accepted_osm_matched").map(m => m.canonical_id))];
    const accMuni = ms.filter(m => m.status === "accepted_municipal_new");
    clusters.push({ cluster_id: `${sc.split("_")[0]}-pp-${String(++cid).padStart(3, "0")}`, group_id: g, class: ms.length >= 2 ? "ONE_PHYSICAL_PARK_CONFIDENT" : "STANDALONE_PHYSICAL_PARK", group_class: ambiguous ? "AMBIGUOUS_CLUSTER" : ms.length >= 2 ? "ONE_PHYSICAL_PARK_CONFIDENT" : "STANDALONE_PHYSICAL_PARK", group_component_count: cs.length, has_overlap_conflict: cs.some(x => conflictComps.has(x)),
      name: ms[0].name, names: [...new Set(ms.map(m => m.name))], district: ms[0].district, size: ms.length, member_ids: ms.map(m => m.id),
      status_counts: ms.reduce((o, m) => (o[m.status] = (o[m.status] ?? 0) + 1, o), {}), name_classes: [...new Set(ms.map(m => m.name_class))],
      accepted_osm_targets: accOsm, accepted_municipal_canonicals: accMuni.map(m => ({ source_id: m.id, canonical_id: m.canonical_id })),
      internal_gap_max_m: Math.max(0, ...links.filter(p => compOf.get(p.a) === c).map(p => p.boundary_gap_m)) });
  }
}
/* ---------- survivor policy ---------- */
const lifecycle = [], decisions = new Map();
for (const cl of clusters) {
  const d = { cluster_id: cl.cluster_id, action: "none", survivor: null, retired: [] };
  const hasAcc = cl.accepted_municipal_canonicals.length + cl.status_counts.accepted_osm_matched > 0 || (cl.status_counts.accepted_osm_matched ?? 0) > 0;
  if (cl.size >= 2 && (cl.accepted_municipal_canonicals.length > 0 || cl.accepted_osm_targets.length > 0)) {
    if (cl.accepted_osm_targets.length > 1) { d.action = "no_consolidation"; d.reason = "cluster members already matched to different OSM canonical parks"; }
    else if (cl.accepted_osm_targets.length === 1) { d.action = "consolidate"; d.survivor = { canonical_id: cl.accepted_osm_targets[0], kind: "osm" }; d.retired = cl.accepted_municipal_canonicals.map(x => x.canonical_id); d.reason = "existing OSM-backed canonical unambiguously represents the cluster (a member was already matched to it); municipal canonicals of the other fragments retired"; }
    else if (cl.accepted_municipal_canonicals.length >= 2) { const s = cl.accepted_municipal_canonicals[0]; d.action = "consolidate"; d.survivor = { canonical_id: s.canonical_id, kind: "municipal", source_id: s.source_id }; d.retired = cl.accepted_municipal_canonicals.slice(1).map(x => x.canonical_id); d.reason = "deterministic municipal survivor = existing canonical of the lowest source id; other fragment canonicals retired"; }
  }
  decisions.set(cl.cluster_id, d);
}
const byCanonical = new Map(canonical.parks.map(p => [p.id, p]));
const refsOf = id => (byCanonical.get(id)?.source_refs ?? []).filter(r => r.source_code === sc);
for (const cl of clusters) {
  const d = decisions.get(cl.cluster_id);
  for (const old of d.retired) lifecycle.push({ old_canonical_id: old, survivor_canonical_id: d.survivor.canonical_id, survivor_kind: d.survivor.kind, cluster_id: cl.cluster_id, reason: d.reason, name: byCanonical.get(old).name, old_latitude: byCanonical.get(old).latitude, old_longitude: byCanonical.get(old).longitude, source_refs_moved: refsOf(old), alias_type: "canonical_redirect_candidate" });
}

/* ---------- rebuild the source contribution from a CLEAN pre-source baseline ---------- */
const isSourceOnly = p => !p.osm_id && (p.source_refs ?? []).length > 0 && p.source_refs.every(r => r.source_code === sc);
const clean = canonical.parks.filter(p => !isSourceOnly(p)).map(p => ({ ...p, source_refs: (p.source_refs ?? []).filter(r => r.source_code !== sc) }));
const cleanById = new Map(clean.map(p => [p.id, p]));
const finalOf = new Map();   // canonical id -> refs
const orig = new Map();      // source id -> original canonical
for (const r of R.values()) if (r.canonical_id) orig.set(r.id, r.canonical_id);
const clusterOfRec = new Map(); for (const cl of clusters) for (const m of cl.member_ids) clusterOfRec.set(m, cl);
for (const [srcId, oc] of orig) { const d = decisions.get(clusterOfRec.get(srcId).cluster_id); const target = d.action === "consolidate" ? d.survivor.canonical_id : oc; if (!finalOf.has(target)) finalOf.set(target, []); }
const refFor = srcId => { const oc = orig.get(srcId); return byCanonical.get(oc).source_refs.find(r => r.source_code === sc && String(r.external_id) === srcId); };
for (const [srcId, oc] of orig) { const d = decisions.get(clusterOfRec.get(srcId).cluster_id); const target = d.action === "consolidate" ? d.survivor.canonical_id : oc; finalOf.get(target).push(refFor(srcId)); }
const preview = [...clean];
let municipalCount = 0;
for (const [cidT, refs] of finalOf) {
  refs.sort((a, b) => Number(a.external_id) - Number(b.external_id));
  const base = cleanById.get(cidT);
  if (base) { base.source_refs = [...(base.source_refs ?? []), ...refs]; continue; }        // OSM (or other) survivor
  const orig0 = byCanonical.get(cidT); const cl = clusters.find(c => c.member_ids.some(m => orig.get(m) === cidT));
  const rec = { ...structuredClone(orig0), source_refs: refs };
  if (cl.size >= 2) rec.provenance_metadata = { ...(rec.provenance_metadata ?? {}), physical_park: { cluster_id: cl.cluster_id, class: cl.class, group_class: cl.group_class, member_source_ids: cl.member_ids, polygon_count: cl.size, retired_duplicate_canonical_ids: decisions.get(cl.cluster_id).retired } };
  preview.push(rec); municipalCount++;
}
const outPreview = { ...canonical, generatedAt: new Date().toISOString(), mode: "nationwide-canonical-preview-HYPOTHETICAL-ordu-physical-park-consolidation", summary: { ...canonical.summary, totalCanonicalParks: preview.length }, parks: preview };
await write(new URL("ordu-consolidation/consolidated-canonical-preview.json", cache), JSON.stringify(outPreview));

/* ---------- report ---------- */
const sourceOnlyBefore = canonical.parks.filter(isSourceOnly).length, sourceOnlyAfter = preview.filter(isSourceOnly).length;
const refsBefore = canonical.parks.reduce((n, p) => n + (p.source_refs ?? []).filter(r => r.source_code === sc).length, 0), refsAfter = preview.reduce((n, p) => n + (p.source_refs ?? []).filter(r => r.source_code === sc).length, 0);
const count = (arr, f) => arr.reduce((o, x) => { const k = f(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});
const report = {
  source_code: sc, thresholds: { link_gap_m: cfg.link_gap_m, generic_link_gap_m: cfg.generic_link_gap_m, gray_zone_max_m: cfg.gray_zone_max_m },
  source_records: R.size, eligible_records: [...R.values()].filter(r => !r.non_park).length, excluded_non_park_evidence: [...R.values()].filter(r => r.non_park).map(r => ({ id: r.id, name: r.name, layer: r.layer })),
  components: clusters.length, confident_multi_record_clusters: clusters.filter(c => c.size >= 2).length, standalone_parks: clusters.filter(c => c.size === 1).length,
  records_in_confident_clusters: clusters.filter(c => c.size >= 2).reduce((n, c) => n + c.size, 0),
  ambiguous_groups: count(clusters.filter(c => c.group_class === "AMBIGUOUS_CLUSTER"), c => c.group_id) && new Set(clusters.filter(c => c.group_class === "AMBIGUOUS_CLUSTER").map(c => c.group_id)).size,
  components_in_ambiguous_groups: clusters.filter(c => c.group_class === "AMBIGUOUS_CLUSTER").length,
  name_classes: count([...R.values()], r => r.name_class),
  consolidation_actions: count([...decisions.values()], d => d.action),
  canonical_before: { source_only: sourceOnlyBefore, total: canonical.parks.length }, canonical_after: { source_only: sourceOnlyAfter, total: preview.length },
  retired_duplicate_canonicals: lifecycle.length, source_refs_before: refsBefore, source_refs_after: refsAfter,
  survivor_kinds: count(lifecycle, l => l.survivor_kind), largest: [...clusters].sort((a, b) => b.size - a.size).slice(0, 12).map(c => ({ cluster_id: c.cluster_id, name: c.name, district: c.district, polygons: c.size, statuses: c.status_counts, current_accepted_municipal_canonicals: c.accepted_municipal_canonicals.length, proposed_physical_parks: 1, action: decisions.get(c.cluster_id).action, group_class: c.group_class, internal_gap_max_m: c.internal_gap_max_m }))
};
await write(new URL("ordu-consolidation/clusters.json", cache), JSON.stringify({ report, clusters: clusters.map(c => ({ ...c, decision: decisions.get(c.cluster_id) })), gray_pairs: gray.map(g => ({ a: g.a, b: g.b, gap_m: g.boundary_gap_m, names: [R.get(g.a).name, R.get(g.b).name] })), overlap_conflicts: conflicts.map(c => ({ a: c.a, b: c.b })) }, null, 1));
await write(new URL("ordu-consolidation/lifecycle.json", cache), JSON.stringify({ source_code: sc, note: "PREVIEW alias/tombstone candidates: no historical identity is deleted; each retired canonical id redirects to its survivor and its source refs move with it.", retired: lifecycle }, null, 1));
// resolver override: per source record
const override = { source_code: sc, records: {} };
// nearest same-name (name evidence, same/unknown district, both eligible) record in ANOTHER component:
// fragment-vs-namesake cannot be decided beyond the link threshold, so consumers must not create parks on it.
const nearestOther = new Map();
for (const p of pairs) {
  const a = R.get(p.a), b = R.get(p.b);
  if (a.non_park || b.non_park || !p.name_evidence || (a.district && b.district && a.district !== b.district) || compOf.get(p.a) === compOf.get(p.b)) continue;
  for (const id of [p.a, p.b]) if (!nearestOther.has(id) || p.boundary_gap_m < nearestOther.get(id)) nearestOther.set(id, p.boundary_gap_m);
}
for (const c of clusters) for (const m of c.member_ids) override.records[m] = { cluster_id: c.cluster_id, size: c.size, class: c.class, group_class: c.group_class, members: c.member_ids, survivor_canonical_id: decisions.get(c.cluster_id).survivor?.canonical_id ?? null, nearest_other_component_same_name_gap_m: nearestOther.get(m) ?? null };
await write(new URL("ordu-consolidation/physical-park-clusters.json", cache), JSON.stringify(override));
console.log(JSON.stringify(report, null, 1));

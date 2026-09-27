import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { clean } from "./park-enrichment.mjs";

// Generic PARK-TAXONOMY GATE for physical-park clusters + canonical ALIAS/TOMBSTONE manifest.
// Physical clustering (consolidate-polygon-source-physical-parks.mjs) decides which polygons are
// ONE object; this gate decides whether that object is a PARK, using only source evidence
// (layer field, name, dataset scope, geometry). No per-name / per-id rules: every cluster runs
// through the same signal logic from data/physical-park-consolidation-config.json#taxonomy_gate.
//   PARK_CONFIRMED / PARK_LIKELY  -> may stay/become canonical
//   TAXONOMY_AMBIGUOUS            -> municipal-only canonicals of the cluster move to review
//   NON_PARK                      -> municipal-only canonicals of the cluster are rejected
// Canonicals backed by OSM (leisure=park) or another source are never demoted by this gate.
// Retired canonical ids are never deleted: each gets exactly one lifecycle entry
// (ALIAS_REDIRECT -> surviving canonical, or TOMBSTONE -> review queue / non-park ledger),
// flattened so no chain or cycle remains. Writes only under .cache/ordu-consolidation/final/.
//   node scripts/physical-park-taxonomy-gate.mjs <source_code>
const sc = process.argv[2] ?? "ordu_acikveri_parklari";
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
const outDir = new URL("ordu-consolidation/final/", cache);
await mkdir(outDir, { recursive: true });
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const pcfg = await J("../../physical-park-consolidation-config.json");
const G = pcfg.taxonomy_gate, scfg = pcfg.sources[sc];
const { configs } = await J("../../municipal-ingestion-configs.json");
const icfg = configs.find(c => c.source_code === sc);
const { clusters } = await J("ordu-consolidation/clusters.json");
const lifecycle = await J("ordu-consolidation/lifecycle.json");
const consolidatedFile = "ordu-consolidation/consolidated-canonical-preview.json";
const consolidatedText = await readFile(new URL(consolidatedFile, cache), "utf8");
const consolidated = JSON.parse(consolidatedText);
const baseFile = "nationwide-canonical-preview.json";
const baseText = await readFile(new URL(baseFile, cache), "utf8");
const base = JSON.parse(baseText);
const raw = await J(`${icfg.cache_dir}/${icfg.raw_filename}`);

/* ---------- member-level semantic signals ---------- */
const NONPARK = new RegExp(pcfg.non_park_keywords, "iu");
const LAYER_PARK = new RegExp(G.layer_park_pattern, "iu");
const PARK_TOKEN = new RegExp(G.name_park_compound_pattern, "u");
const lower = s => clean(s).toLocaleLowerCase("tr");
const tokens = s => lower(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const nonGreen = s => G.non_green_park_compounds.some(t => lower(s).includes(t));
const namePark = n => !nonGreen(n) && tokens(n).some(t => PARK_TOKEN.test(t));
const featById = new Map(raw.features.filter(f => f.properties?.[icfg.id_field] != null).map(f => [String(f.properties[icfg.id_field]), f]));
function memberSignals(id) {
  const p = featById.get(id).properties, name = clean(p[icfg.name_field]) || "", layer = scfg.layer_field ? clean(p[scfg.layer_field]) || "" : "";
  const np = namePark(name);
  return {
    id, name, layer, source_area_m2: p.ALANI ?? null,
    name_park_word: np,
    layer_park_token: !!layer && LAYER_PARK.test(lower(layer)) && !nonGreen(layer) && !NONPARK.test(layer),
    non_park_keyword: (!!layer && NONPARK.test(layer)) || (!np && NONPARK.test(name)),
    facility_token: tokens(name).find(t => G.facility_tokens.includes(t)) ?? null,
    green_space_token: tokens(name).find(t => G.green_space_tokens.includes(t)) ?? null
  };
}

/* ---------- cluster geometry (local metric plane) ---------- */
const KY = 110540;
function geometry(ids) {
  const polysOf = id => { const g = featById.get(id).geometry; return g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]; };
  const lat0 = polysOf(ids[0])[0][0][0][1], kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let area = 0; const V = [], memberAreas = [];
  for (const id of ids) {
    let ma = 0;
    for (const poly of polysOf(id)) poly.forEach((ring, ri) => {
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) { const x1 = ring[i][0] * kx, y1 = ring[i][1] * KY, x2 = ring[i + 1][0] * kx, y2 = ring[i + 1][1] * KY; a += x1 * y2 - x2 * y1; if (ri === 0) V.push([x1, y1]); }
      ma += (ri === 0 ? 1 : -1) * Math.abs(a) / 2;
    });
    memberAreas.push(ma); area += ma;
  }
  let L = 0;
  for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) L = Math.max(L, Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1]));
  const compactness = L ? area / (L * L) : 1, meanWidth = L ? area / L : 0;
  const linear = compactness < G.linear_max_compactness;
  return { polygon_area_sum_m2: Math.round(area), max_extent_m: Math.round(L), mean_width_m: Math.round(meanWidth * 10) / 10, compactness: Math.round(compactness * 10000) / 10000,
    linear, path_like: linear && meanWidth < G.path_max_mean_width_m, sub_park_scale_members: memberAreas.filter(a => a < G.sub_park_scale_member_area_m2).length };
}

/* ---------- classification (identical logic for every cluster) ---------- */
const LEVELS = ["TAXONOMY_AMBIGUOUS", "PARK_LIKELY", "PARK_CONFIRMED"];
function classify(ms, geo) {
  const frac = k => ms.filter(m => m[k]).length / ms.length >= G.member_signal_fraction;
  const s = { name_park_word: frac("name_park_word"), layer_park_token: frac("layer_park_token"), non_park_keyword: frac("non_park_keyword"), facility_name: frac("facility_token"), green_space_name: frac("green_space_token") };
  const basis = [];
  if (s.non_park_keyword && !s.name_park_word) return { cls: "NON_PARK", s, basis: ["non-park keyword in source layer/name, no park word in name"] };
  if (s.facility_name && !s.name_park_word) return { cls: "TAXONOMY_AMBIGUOUS", s, basis: ["facility name (no park word) — a facility inside a park-and-green-area dataset is not evidence of a park"] };
  const strength = (s.name_park_word ? 1 : 0) + (s.layer_park_token ? 1 : 0);
  let lvl = strength;
  basis.push(`${strength} row-level park signal(s): name park word=${s.name_park_word}, layer park token=${s.layer_park_token}; dataset scope '${scfg.dataset_scope}' alone is not sufficient`);
  if (geo.path_like && lvl > 0) { lvl--; basis.push(`path-like geometry (compactness ${geo.compactness} < ${G.linear_max_compactness}, mean width ${geo.mean_width_m} m < ${G.path_max_mean_width_m} m) downgrades one level`); }
  // with a single row-level signal, LINEAR geometry alone (any width) is enough doubt: a layer token cannot tell a strip park from a road verge / promenade
  else if (geo.linear && strength === 1 && G.linear_downgrades_single_signal) { lvl--; basis.push(`linear geometry (compactness ${geo.compactness} < ${G.linear_max_compactness}, length ${geo.max_extent_m} m, mean width ${geo.mean_width_m} m) with only one row-level park signal downgrades one level`); }
  else if (geo.path_like) basis.push(`path-like geometry (compactness ${geo.compactness}, mean width ${geo.mean_width_m} m)`);
  return { cls: LEVELS[lvl], s, basis };
}

/* ---------- apply to clusters ---------- */
const consById = new Map(consolidated.parks.map(p => [p.id, p]));
const canonOfRef = new Map();
for (const p of consolidated.parks) for (const r of p.source_refs ?? []) if (r.source_code === sc) canonOfRef.set(String(r.external_id), p.id);
const sourceOnly = p => !p.osm_id && (p.source_refs ?? []).length > 0 && p.source_refs.every(r => r.source_code === sc);
const taxonomy = [], demoted = new Map();   // canonical id -> { cluster, cls }
for (const c of clusters) {
  const ms = c.member_ids.map(memberSignals), geo = geometry(c.member_ids), { cls, s, basis } = classify(ms, geo);
  const canonIds = [...new Set(c.member_ids.map(id => canonOfRef.get(id)).filter(Boolean))];
  const municipalOnly = canonIds.filter(id => sourceOnly(consById.get(id)));
  const gated = cls === "TAXONOMY_AMBIGUOUS" || cls === "NON_PARK";
  const effect = !gated ? "none" : municipalOnly.length ? (cls === "NON_PARK" ? "municipal canonical rejected" : "municipal canonical moved to review") : canonIds.length ? "none (represented by an OSM/other-source canonical park)" : "review records only: blocks NEW/spatial decisions";
  if (gated) for (const id of municipalOnly) demoted.set(id, { cluster: c, cls });
  taxonomy.push({ cluster_id: c.cluster_id, name: c.name, names: c.names, district: c.district, size: c.size, group_class: c.group_class, consolidation_action: c.decision.action, status_counts: c.status_counts,
    taxonomy_class: cls, basis, cluster_signals: s, geometry: geo, layers: [...new Set(ms.map(m => m.layer))], current_canonical_ids: canonIds, municipal_only_canonical_ids: municipalOnly, gate_effect: effect, members: ms });
}

/* ---------- lifecycle: ALIAS_REDIRECT / TOMBSTONE, flattened ---------- */
const snapshot = { base_file: baseFile, base_generated_at: base.generatedAt, base_sha256: createHash("sha256").update(baseText).digest("hex"), consolidated_file: consolidatedFile, consolidated_sha256: createHash("sha256").update(consolidatedText).digest("hex") };
const created_at = new Date().toISOString();
const baseById = new Map(base.parks.map(p => [p.id, p]));
const refsOn = id => (baseById.get(id)?.source_refs ?? []).filter(r => r.source_code === sc);
const aliasTarget = new Map(lifecycle.retired.map(l => [l.old_canonical_id, l]));
const resolve = id => { const seen = new Set(); while (aliasTarget.has(id)) { if (seen.has(id)) throw new Error(`alias cycle at ${id}`); seen.add(id); id = aliasTarget.get(id).survivor_canonical_id; } return id; };
const manifest = [];
const tomb = (id, cls, cluster, via) => ({ lifecycle_action: cls === "NON_PARK" ? "TOMBSTONE_NON_PARK" : "TOMBSTONE_TAXONOMY_REVIEW", survivor_canonical_id: null, resolves_to: cls === "NON_PARK" ? { kind: "non_park_ledger" } : { kind: "taxonomy_review_queue", cluster_id: cluster.cluster_id },
  reason: `${via}physical-park cluster ${cluster.cluster_id} classified ${cls} by the taxonomy gate; municipal-only canonical ${cls === "NON_PARK" ? "rejected" : "moved to review"} (not hard-deleted)`, taxonomy_class: cls, cluster_id: cluster.cluster_id });
for (const l of lifecycle.retired) {
  const final = resolve(l.old_canonical_id);
  const common = { retired_canonical_id: l.old_canonical_id, source_code: sc, name: l.name, old_latitude: l.old_latitude, old_longitude: l.old_longitude, source_refs_preserved: refsOn(l.old_canonical_id), created_at, effective_snapshot: snapshot };
  if (demoted.has(final)) { const d = demoted.get(final); manifest.push({ ...common, ...tomb(l.old_canonical_id, d.cls, d.cluster, `retired into ${final} by consolidation, then `), consolidation_survivor_canonical_id: final, source_refs_location: d.cls === "NON_PARK" ? "non_park_ledger" : "taxonomy_review_queue" }); }
  else manifest.push({ ...common, lifecycle_action: "ALIAS_REDIRECT", survivor_canonical_id: final, survivor_kind: l.survivor_kind, resolves_to: { kind: "canonical", canonical_id: final }, reason: l.reason, cluster_id: l.cluster_id, source_refs_location: "survivor_canonical" });
}
for (const [id, d] of demoted) {
  const p = baseById.get(id) ?? consById.get(id);
  manifest.push({ retired_canonical_id: id, source_code: sc, name: p.name, old_latitude: p.latitude, old_longitude: p.longitude, source_refs_preserved: refsOn(id), created_at, effective_snapshot: snapshot, ...tomb(id, d.cls, d.cluster, ""), source_refs_location: d.cls === "NON_PARK" ? "non_park_ledger" : "taxonomy_review_queue" });
}

/* ---------- gated canonical preview + review queue / non-park ledger ---------- */
const gatedParks = consolidated.parks.filter(p => !demoted.has(p.id));
const queue = [], ledger = [];
for (const [id, d] of demoted) {
  const p = consById.get(id);
  for (const ref of p.source_refs) {
    const f = featById.get(String(ref.external_id)), m = taxonomy.find(t => t.cluster_id === d.cluster.cluster_id);
    const rec = { source_code: sc, external_id: String(ref.external_id), name: clean(f.properties[icfg.name_field]), province: icfg.province, district: d.cluster.district ?? "", latitude: p.latitude, longitude: p.longitude,
      review_reason: d.cls === "NON_PARK" ? "taxonomy_non_park" : "taxonomy_ambiguous_physical_park", cluster_id: d.cluster.cluster_id, taxonomy_class: d.cls, taxonomy_basis: m.basis, demoted_canonical_id: id, source_ref: ref };
    (d.cls === "NON_PARK" ? ledger : queue).push(rec);
  }
}
const gated = { ...consolidated, generatedAt: created_at, mode: "nationwide-canonical-preview-HYPOTHETICAL-ordu-consolidation+taxonomy-gate", summary: { ...consolidated.summary, totalCanonicalParks: gatedParks.length }, parks: gatedParks };

/* ---------- resolver override (clusters + taxonomy class per record) ---------- */
const override = await J("ordu-consolidation/physical-park-clusters.json");
const clsOf = new Map(taxonomy.map(t => [t.cluster_id, t.taxonomy_class]));
for (const r of Object.values(override.records)) {
  r.taxonomy_class = clsOf.get(r.cluster_id);
  if (r.survivor_canonical_id && demoted.has(r.survivor_canonical_id)) r.survivor_canonical_id = null;
}

/* ---------- self-validation of the manifest ---------- */
const finalIds = new Set(gatedParks.map(p => p.id));
const count = (arr, f) => arr.reduce((o, x) => { const k = f(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});
const retiredIds = manifest.map(m => m.retired_canonical_id), retiredSet = new Set(retiredIds);
const aliases = manifest.filter(m => m.lifecycle_action === "ALIAS_REDIRECT");
const checks = {
  entries: manifest.length, by_action: count(manifest, m => m.lifecycle_action),
  duplicate_retired_id: retiredIds.length - retiredSet.size,
  self_alias: aliases.filter(m => m.survivor_canonical_id === m.retired_canonical_id).length,
  missing_survivor: aliases.filter(m => !finalIds.has(m.survivor_canonical_id)).length,
  survivor_is_retired_chain: aliases.filter(m => retiredSet.has(m.survivor_canonical_id)).length,
  retired_id_still_in_preview: retiredIds.filter(id => finalIds.has(id)).length,
  consolidation_retired_covered: lifecycle.retired.every(l => retiredSet.has(l.old_canonical_id)),
  refs_preserved_total: manifest.reduce((n, m) => n + m.source_refs_preserved.length, 0)
};
const model = {
  table_concepts: {
    canonical_park_aliases: "retired_park_id (PK) -> canonical_park_id (must exist, never itself retired), reason, source_code, cluster_id, created_at, effective_snapshot",
    canonical_park_tombstones: "retired_park_id (PK), status (taxonomy_review | non_park), reason, source_code, cluster_id, source_refs (kept in the review/ledger record), created_at, effective_snapshot"
  },
  resolution_rule: "lookup(id): live canonical -> itself; alias -> survivor (one hop, chains are flattened at write time); tombstone -> not a live park (review / rejected), never 404-by-deletion",
  flattening: "A consolidation alias whose survivor is later tombstoned becomes a tombstone itself (same destination as its survivor), so no alias ever points to a non-live id."
};
await writeFile(new URL("taxonomy.json", outDir), JSON.stringify({ source_code: sc, dataset_scope: scfg.dataset_scope, dataset_description: scfg.dataset_description, config: G, summary: { by_class: count(taxonomy, t => t.taxonomy_class), by_class_records: taxonomy.reduce((o, t) => (o[t.taxonomy_class] = (o[t.taxonomy_class] ?? 0) + t.size, o), {}), by_effect: count(taxonomy, t => t.gate_effect) }, clusters: taxonomy }, null, 1));
await writeFile(new URL("gated-canonical-preview.json", outDir), JSON.stringify(gated));
await writeFile(new URL("canonical-alias-manifest.json", outDir), JSON.stringify({ source_code: sc, generated_at: created_at, model, checks, entries: manifest }, null, 1));
await writeFile(new URL("taxonomy-review-queue.json", outDir), JSON.stringify({ source_code: sc, generated_at: created_at, review_records: queue, non_park_ledger: ledger }, null, 1));
await writeFile(new URL("physical-park-clusters.json", outDir), JSON.stringify(override));
console.log(JSON.stringify({
  taxonomy_by_class: count(taxonomy, t => t.taxonomy_class), gated_clusters: taxonomy.filter(t => t.gate_effect.startsWith("municipal")).map(t => ({ cluster_id: t.cluster_id, name: t.name, size: t.size, cls: t.taxonomy_class, municipal_canonicals: t.municipal_only_canonical_ids.length, basis: t.basis })),
  canonical: { consolidated: consolidated.parks.length, gated: gatedParks.length, demoted: demoted.size }, municipal_only_after: gatedParks.filter(sourceOnly).length, review_queue_records: queue.length, non_park_ledger_records: ledger.length, manifest: checks
}, null, 1));

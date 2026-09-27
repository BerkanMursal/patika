import { readFile } from "node:fs/promises";
// Read-only audit of a physical-park consolidation preview: structural checks on EVERY
// cluster + compact listing of the clusters to be inspected manually.
//   node scripts/audit-physical-park-consolidation.mjs
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const D = await J("ordu-consolidation/clusters.json"), inv = await J("ordu-consolidation/inventory.json"), pairs = await J("ordu-consolidation/pairs.json");
const life = await J("ordu-consolidation/lifecycle.json"), prev = await J("ordu-consolidation/consolidated-canonical-preview.json"), cur = await J("nationwide-canonical-preview.json");
const cfg = await J("../../physical-park-consolidation-config.json");
const R = new Map(inv.records.map(r => [r.id, r]));
const pair = new Map(pairs.map(p => [`${p.a}|${p.b}`, p]));
const gap = (a, b) => pair.get(`${a}|${b}`) ?? pair.get(`${b}|${a}`);
const prevById = new Map(prev.parks.map(p => [p.id, p]));
const problems = [];
for (const c of D.clusters) {
  const ms = c.member_ids.map(id => R.get(id));
  if (new Set(ms.map(m => m.district)).size > 1) problems.push(`${c.cluster_id}: members in different districts`);
  if (ms.some(m => m.non_park)) problems.push(`${c.cluster_id}: non-park member`);
  // connectivity: every member reachable via a qualifying link (re-derived independently)
  const seen = new Set([c.member_ids[0]]); const q = [c.member_ids[0]];
  while (q.length) { const x = q.pop(); for (const y of c.member_ids) { if (seen.has(y)) continue; const p = gap(x, y); if (p && p.name_evidence && (p.intersects || p.touches || p.boundary_gap_m <= cfg.link_gap_m)) { seen.add(y); q.push(y); } } }
  if (seen.size !== c.size) problems.push(`${c.cluster_id}: not connected under the link rule (${seen.size}/${c.size})`);
  const d = c.decision;
  if (d.action === "consolidate") {
    const surv = prevById.get(d.survivor.canonical_id);
    if (!surv) problems.push(`${c.cluster_id}: survivor missing in preview`);
    else { const have = new Set(surv.source_refs.map(r => r.external_id)); const need = c.member_ids.filter(m => R.get(m).status !== "review"); for (const n of need) if (!have.has(n)) problems.push(`${c.cluster_id}: survivor lacks ref ${n}`); }
    for (const old of d.retired) if (prevById.has(old)) problems.push(`${c.cluster_id}: retired canonical ${old} still present`);
  }
}
const lifeIds = new Set(life.retired.map(l => l.old_canonical_id));
const refsMoved = life.retired.reduce((n, l) => n + l.source_refs_moved.length, 0);
console.log(JSON.stringify({ clusters: D.clusters.length, structural_problems: problems, retired: life.retired.length, refs_moved: refsMoved, retired_ids_unique: lifeIds.size === life.retired.length }, null, 1));
const row = c => `${c.cluster_id} '${c.name}'${c.names.length > 1 ? " +" + (c.names.length - 1) + " variants" : ""} [${c.district}] n=${c.size} ${JSON.stringify(c.status_counts)} maxgap=${c.internal_gap_max_m}m group=${c.group_class.slice(0, 9)}(${c.group_component_count}c) action=${c.decision.action}${c.decision.survivor ? " survivor=" + c.decision.survivor.kind : ""} ids=${c.member_ids.slice(0, 8).join(",")}${c.size > 8 ? ",…" : ""}`;
console.log("\n--- small confident multi-record clusters (2-4 polygons)"); for (const c of D.clusters.filter(c => c.size >= 2 && c.size < 5)) console.log(row(c));
console.log("\n--- components inside AMBIGUOUS groups"); for (const c of D.clusters.filter(c => c.group_class === "AMBIGUOUS_CLUSTER")) console.log(row(c));
console.log("\n--- gray-zone pairs (20-40 m)"); for (const g of D.gray_pairs.slice(0, 40)) console.log(`${g.gap_m} m  #${g.a} '${g.names[0]}' ~ #${g.b} '${g.names[1]}'`);
console.log("\n--- overlap conflicts", D.overlap_conflicts.length);

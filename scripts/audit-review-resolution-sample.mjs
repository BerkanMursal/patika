import { readFile, writeFile } from "node:fs/promises";
import { distanceMeters } from "./park-enrichment.mjs";

// Fixed-seed, reproducible sample audit of .cache/review-resolution/resolution.json.
// Independent re-checks (source record exists in the raw file, recorded distance
// re-derived from raw coordinates, target exists and is in the same province,
// outcome invariants) plus a compact printout for manual reading. Read-only.
//   node scripts/audit-review-resolution-sample.mjs [seed]
const seed = Number(process.argv[2] ?? 20260925);
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const res = await J("review-resolution/resolution.json");
const canon = await J("nationwide-canonical-preview.json");
const backlog = await J("municipal-review-backlog.json");
const { configs } = await J("../../municipal-ingestion-configs.json");
const byId = new Map(canon.parks.map(p => [p.id, p]));
const raw = {};
for (const sc of Object.keys(backlog.bySource)) { const c = configs.find(x => x.source_code === sc); raw[sc] = new Map((await J(`${c.cache_dir}/${c.raw_filename}`)).features.map(f => [String(f.properties[c.id_field]), f])); }

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sample(items, n, sd) { if (items.length <= n) return items.slice(); const rng = mulberry32(sd), idx = items.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx.slice(0, n).sort((a, b) => a - b).map(i => items[i]); }
// stratify across sources so no source is missed
function strat(items, n, sd) { const by = {}; for (const x of items) (by[x.source_code] ??= []).push(x); const srcs = Object.keys(by); const per = Math.max(1, Math.floor(n / srcs.length)); let out = []; for (const s of srcs) out.push(...sample(by[s], per, sd)); const rest = items.filter(x => !out.includes(x)); out.push(...sample(rest, Math.max(0, n - out.length), sd + 1)); return out.slice(0, Math.max(n, out.length > n ? n : out.length)); }

const rec = res.records, of = o => rec.filter(x => x.proposed_outcome === o);
const groups = { MATCH_EXISTING: strat(of("MATCH_EXISTING"), 30, seed + 1), NEW_CANONICAL_SAFE: strat(of("NEW_CANONICAL_SAFE"), 30, seed + 2), REJECT: [...of("REJECT_DUPLICATE"), ...of("REJECT_NON_PARK")].slice(0, 20), KEEP_REVIEW: strat(of("KEEP_REVIEW"), 30, seed + 3) };
const problems = [];
function check(x) {
  const issues = [];
  const f = raw[x.source_code].get(x.source_external_id);
  if (!f) issues.push("source record missing in raw");
  const e = x.evidence;
  if (x.proposed_outcome === "MATCH_EXISTING") {
    const t = byId.get(x.target_canonical_id);
    if (!t) issues.push("target missing"); else {
      if (t.city !== x.province) issues.push("target in another province");
      if (f?.geometry?.type === "Point") { const d = distanceMeters({ latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] }, t); if (d > 260) issues.push(`recomputed point distance ${Math.round(d)} m > 260`); }
      if (!e.flags.TRUSTWORTHY_PARK_EVIDENCE && x.match_mode !== "NAME_DRIVEN") issues.push("spatial match without trustworthy park evidence");
      if (e.flags.DISTRICT_CONFLICT && e.candidates.find(c => c.canonical_id === x.target_canonical_id)?.district === "DISTRICT_CONFLICT") issues.push("district conflict with target");
    }
  }
  if (x.proposed_outcome === "NEW_CANONICAL_SAFE") {
    if (e.flags.CROSS_SOURCE_DUPLICATE_EVIDENCE || e.flags.GEOMETRY_OVERLAP || e.flags.GEOMETRY_ADJACENT || e.flags.VERY_CLOSE) issues.push("NEW despite duplicate/overlap/very-close evidence");
    if (e.flags.GENERIC_NAME || e.flags.PLACEHOLDER_NAME) issues.push("NEW with generic/placeholder name");
    if (!e.flags.TRUSTWORTHY_PARK_EVIDENCE) issues.push("NEW without trustworthy evidence");
    if (e.cluster.ambiguous_neighbors.length) issues.push("NEW with ambiguous neighbour");
  }
  if (x.proposed_outcome === "REJECT_DUPLICATE" && !(x.provenance_attach_to_canonical_id || x.provenance_attach_to_new_source_external_id)) issues.push("duplicate without provenance target");
  return issues;
}
const compact = x => {
  const e = x.evidence, fl = e.flags;
  const c = e.candidates.slice(0, 3).map(c => `${c.name}|${c.effective_distance_m}m|${c.relation}|${c.name_relationship.kind ?? (c.name_relationship.numeric_conflict ? "numconf" : "-")}|${c.district === "UNKNOWN" ? "" : c.district[0]}`).join(" ; ");
  return `${x.source_code.split("_")[0]} #${x.source_external_id} '${x.name}' [${x.district ?? "-"}] ${x.original_review_reason.slice(0, 14)} -> ${x.proposed_outcome}${x.target_canonical_id ? " -> " + (byId.get(x.target_canonical_id)?.name ?? "?") : ""} | ${c} | ${x.decision_reason.slice(0, 110)}`;
};
const report = { seed, groups: {}, problems: [] };
for (const [g, items] of Object.entries(groups)) {
  const rows = items.map(x => ({ key: `${x.source_code}:${x.source_external_id}`, issues: check(x), line: compact(x) }));
  report.groups[g] = { sampled: rows.length, with_issues: rows.filter(r => r.issues.length).length, rows };
  console.log(`\n===== ${g}: ${rows.length} sampled, ${rows.filter(r => r.issues.length).length} automated issues`);
  for (const r of rows) console.log((r.issues.length ? "!! " + r.issues.join(",") + " :: " : "") + r.line);
}
await writeFile(new URL("review-resolution/sample-audit.json", cache), JSON.stringify(report, null, 1));

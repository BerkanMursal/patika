import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, serializeArray, validateBundle, BUNDLE_FILES, REQUIRED_TABLES, REQUIRED_FUNCTIONS } from "./canonical-release-bundle.mjs";

// Exports an ALREADY-FROZEN canonical release candidate into the importer bundle
// format (docs/CANONICAL_PARK_LIFECYCLE.md §8). No matching / taxonomy decision is
// recomputed: every record is copied from the frozen artifacts named in
// data/canonical-releases/<release_id>.json, whose sha256 values and expected
// counts must match exactly or the export aborts. Output is byte-deterministic.
//   node scripts/export-canonical-release-bundle.mjs [--release=patika-parks-2026-09-27-rc1] [--out=<dir>]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2), val = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const releaseId = val("release") ?? "patika-parks-2026-09-27-rc1";
const cfgPath = path.join(root, "data/canonical-releases", `${releaseId}.json`);
const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
const outDir = path.resolve(val("out") ?? path.join(root, "data/park-enrichment/.cache/releases", releaseId));

/* ---------- frozen inputs: hash-checked before use ---------- */
const src = {};
for (const [name, a] of Object.entries(cfg.source_artifacts)) {
  const buf = await readFile(path.join(root, a.path));
  if (sha256(buf) !== a.sha256) throw new Error(`frozen source ${name} (${a.path}) sha256 ${sha256(buf)} != ${a.sha256}; refusing to export`);
  src[name] = JSON.parse(buf);
}
const { configs } = JSON.parse(await readFile(path.join(root, "data/municipal-ingestion-configs.json"), "utf8"));
const cfgOf = Object.fromEntries(configs.map(c => [c.source_code, c]));
const sourceUrl = (sc, id) => cfgOf[sc] ? `${cfgOf[sc].dataset_url}#${cfgOf[sc].external_id_url_param}_${id}` : "";
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const byStr = (...ks) => (a, b) => { for (const k of ks) { const x = String(a[k]), y = String(b[k]); if (x !== y) return x < y ? -1 : 1; } return 0; };

/* ---------- parks: same normalisation as scripts/import-nationwide-canonical.mjs ---------- */
const details = src.park_details;
const parks = src.final_canonical_preview.parks.map(p => {
  const osmBacked = Boolean(p.osm_id), unnamed = !clean(p.name) || clean(p.name) === "İsimsiz park";
  const row = {
    id: p.id, osm_id: p.osm_id ?? null, name: clean(p.name), city: clean(p.city), district: clean(p.district), latitude: p.latitude, longitude: p.longitude,
    source: osmBacked ? "OpenStreetMap" : p.source || "Belediye kaynağı",
    name_status: p.name_status ?? (osmBacked ? (unnamed ? "missing" : "source") : "municipal"),
    name_source: p.name_source ?? (osmBacked ? "OpenStreetMap" : p.source || "Belediye kaynağı"),
    name_source_url: p.name_source_url ?? (osmBacked ? `https://www.openstreetmap.org/${p.osm_id}` : ""),
    address_label: ""
  };
  if (osmBacked) for (const k of ["name_status", "name_source", "name_source_url", "address_label"]) if (details[p.id]?.[k] !== undefined) row[k] = details[p.id][k];
  return row;
}).sort(byStr("id"));
const park_source_refs = src.final_canonical_preview.parks.flatMap(p => (p.source_refs ?? []).map(r => ({ source_code: clean(r.source_code), external_id: clean(r.external_id), park_id: p.id, source_url: clean(r.source_url) }))).sort(byStr("source_code", "external_id"));

/* ---------- lifecycle ---------- */
const E = src.canonical_alias_manifest.entries;
const refOut = r => ({ source_code: r.source_code, external_id: String(r.external_id), source_url: r.source_url ?? "" });
const aliases = E.filter(e => e.lifecycle_action === "ALIAS_REDIRECT").map(e => ({ retired_park_id: e.retired_canonical_id, canonical_park_id: e.survivor_canonical_id, reason: e.reason, source_code: e.source_code, cluster_id: e.cluster_id ?? null, source_refs_preserved: e.source_refs_preserved.map(refOut) })).sort(byStr("retired_park_id"));
const STATUS = { TOMBSTONE_TAXONOMY_REVIEW: "taxonomy_review", TOMBSTONE_NON_PARK: "non_park" };
const tombstones = E.filter(e => e.lifecycle_action !== "ALIAS_REDIRECT").map(e => {
  if (!STATUS[e.lifecycle_action]) throw new Error(`unknown lifecycle action ${e.lifecycle_action}`);
  return { retired_park_id: e.retired_canonical_id, status: STATUS[e.lifecycle_action], reason: e.reason, source_code: e.source_code, cluster_id: e.cluster_id ?? null, source_refs: e.source_refs_preserved.map(refOut) };
}).sort(byStr("retired_park_id"));

/* ---------- reviews + rejections ---------- */
const res = src.review_resolution.records, queue = src.taxonomy_review_queue;
const slimCandidates = cs => (cs ?? []).map(c => ({ canonical_id: c.canonical_id, osm_id: c.osm_id ?? null, name: c.name, effective_distance_m: c.effective_distance_m, relation: c.relation, plausible: c.plausible, name_relationship: c.name_relationship?.kind ?? null }));
const reviews = [
  ...res.filter(r => r.proposed_outcome === "KEEP_REVIEW").map(r => ({
    source_code: r.source_code, external_id: String(r.source_external_id), review_reason: r.original_review_reason, name: clean(r.name), province: r.province ?? "", district: r.district ?? "",
    latitude: r.latitude ?? null, longitude: r.longitude ?? null,
    candidate_canonical_ids: (r.evidence?.candidates ?? []).filter(c => c.plausible).map(c => c.canonical_id),
    related_canonical_id: null, source_url: sourceUrl(r.source_code, r.source_external_id),
    evidence: { outcome: "KEEP_REVIEW", decision_reason: r.decision_reason, flags: r.evidence?.flags ?? {}, taxonomy_class: r.evidence?.taxonomy_class ?? null, park_evidence_basis: r.evidence?.park_evidence_basis ?? null, cluster: r.evidence?.cluster ?? null, candidates: slimCandidates(r.evidence?.candidates) }
  })),
  ...queue.review_records.map(r => ({
    source_code: r.source_code, external_id: String(r.external_id), review_reason: r.review_reason, name: clean(r.name), province: r.province ?? "", district: r.district ?? "",
    latitude: r.latitude ?? null, longitude: r.longitude ?? null, candidate_canonical_ids: [], related_canonical_id: r.demoted_canonical_id,
    source_url: r.source_ref?.source_url ?? sourceUrl(r.source_code, r.external_id),
    evidence: { outcome: "TAXONOMY_REVIEW", cluster_id: r.cluster_id, taxonomy_class: r.taxonomy_class, taxonomy_basis: r.taxonomy_basis, demoted_canonical_id: r.demoted_canonical_id }
  }))
].sort(byStr("source_code", "external_id"));
const rejections = [
  ...res.filter(r => r.proposed_outcome === "REJECT_NON_PARK").map(r => ({
    source_code: r.source_code, external_id: String(r.source_external_id), classification: "non_park", reason: r.decision_reason, taxonomy_class: r.taxonomy_class ?? r.evidence?.taxonomy_class ?? null,
    retired_park_id: null, source_url: sourceUrl(r.source_code, r.source_external_id),
    evidence: { outcome: "REJECT_NON_PARK", original_review_reason: r.original_review_reason, name: clean(r.name), latitude: r.latitude, longitude: r.longitude, non_park_evidence: r.non_park_evidence ?? null, flags: r.evidence?.flags ?? {} }
  })),
  ...queue.non_park_ledger.map(r => ({
    source_code: r.source_code, external_id: String(r.external_id), classification: "non_park", reason: (r.taxonomy_basis ?? []).join("; ") || "taxonomy gate NON_PARK", taxonomy_class: r.taxonomy_class,
    retired_park_id: r.demoted_canonical_id, source_url: r.source_ref?.source_url ?? sourceUrl(r.source_code, r.external_id),
    evidence: { outcome: "TAXONOMY_NON_PARK", cluster_id: r.cluster_id, name: clean(r.name), latitude: r.latitude, longitude: r.longitude, taxonomy_basis: r.taxonomy_basis }
  }))
].sort(byStr("source_code", "external_id"));

/* ---------- write + manifest ---------- */
await mkdir(outDir, { recursive: true });
const files = { "parks.json": parks, "park_source_refs.json": park_source_refs, "aliases.json": aliases, "tombstones.json": tombstones, "reviews.json": reviews, "rejections.json": rejections };
const artifacts = [];
for (const f of BUNDLE_FILES) {
  const buf = Buffer.from(serializeArray(files[f]));
  await writeFile(path.join(outDir, f), buf);
  artifacts.push({ file: f, sha256: sha256(buf), records: files[f].length });
}
const manifest = {
  bundle_format: 1,
  release_id: cfg.release_id,
  created_at: cfg.created_at,
  generator: "scripts/export-canonical-release-bundle.mjs",
  base_snapshot: cfg.source_artifacts.base_snapshot,
  base_snapshot_sha256: cfg.source_artifacts.base_snapshot.sha256,
  source_artifacts: cfg.source_artifacts,
  artifacts,
  expected_counts: cfg.expected_counts,
  source_scope: [...new Set([...park_source_refs, ...reviews, ...rejections, ...tombstones.flatMap(t => t.source_refs)].map(r => r.source_code))].sort(),
  prerequisites: { schema_migration: cfg.required_schema_migration, tables: REQUIRED_TABLES, functions: REQUIRED_FUNCTIONS },
  db_only_policy: {
    rule: "A database park that is neither a live park, an alias nor a tombstone of this release is DB-only. It is classified by evidence, never by id or name: SOURCE_WITHDRAWN_{WITH,NO}_HISTORY = has provenance (osm_id and/or park_source_refs), all provenance sources are in source_scope, and none of its refs appears anywhere in this release -> tombstone status source_withdrawn, row kept inactive, refs moved to tombstone refs, user rows untouched. TEST_FIXTURE = no provenance at all, listed in the target environment's fixture policy, and every user-content author has a reserved test-domain account -> left untouched. Anything else = UNKNOWN_DB_ONLY -> the importer aborts.",
    history: "feeding_events, observations, favorites, park_name_suggestions or reports referencing the park (or its feeding points)"
  }
};
const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(outDir, "manifest.json"), manifestBuf);
const manifestSha256 = sha256(manifestBuf);
if (cfg.expected_manifest_sha256 && cfg.expected_manifest_sha256 !== manifestSha256) throw new Error(`re-export is not byte-identical: manifest ${manifestSha256} != frozen ${cfg.expected_manifest_sha256}`);
const v = await validateBundle(outDir, { expectedManifestSha256: cfg.expected_manifest_sha256 ?? manifestSha256, expectedCounts: cfg.expected_counts, releaseId: cfg.release_id });
console.log(JSON.stringify({ release_id: cfg.release_id, out: path.relative(root, outDir), manifest_sha256: manifestSha256, pinned: !!cfg.expected_manifest_sha256, artifacts, counts: v.counts, source_scope: manifest.source_scope }, null, 1));

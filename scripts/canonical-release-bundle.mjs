import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// Shared contract for canonical release bundles (see docs/CANONICAL_PARK_LIFECYCLE.md §8):
// deterministic serialisation, hashing and the hard-failing validator used by both
// export-canonical-release-bundle.mjs and apply-canonical-release.mjs.

export const BUNDLE_FILES = ["parks.json", "park_source_refs.json", "aliases.json", "tombstones.json", "reviews.json", "rejections.json"];
export const TOMBSTONE_STATUSES = ["taxonomy_review", "non_park", "source_withdrawn"];
export const REQUIRED_TABLES = ["canonical_park_releases", "canonical_park_aliases", "canonical_park_tombstones", "canonical_park_tombstone_refs", "canonical_park_reviews", "canonical_park_rejections"];
export const REQUIRED_FUNCTIONS = ["resolve_park_id(uuid)"];

export const sha256 = buf => createHash("sha256").update(buf).digest("hex");
export const sha256File = async p => sha256(await readFile(p));

// one record per line, stable key order as produced by the exporter, trailing newline
export const serializeArray = rows => `[\n${rows.map(r => JSON.stringify(r)).join(",\n")}\n]\n`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refKey = r => `${r.source_code}:${r.external_id}`;

// Validates a bundle directory. Throws on the FIRST class of problem found (hard failure).
//   expectedManifestSha256: required unless allowUnpinned (only the exporter's self-check uses that)
export async function validateBundle(dir, { expectedManifestSha256 = null, expectedCounts = null, releaseId = null, allowUnpinned = false } = {}) {
  const fail = msg => { throw new Error(`bundle validation failed: ${msg}`); };
  const manifestBuf = await readFile(path.join(dir, "manifest.json"));
  const manifestSha256 = sha256(manifestBuf);
  if (expectedManifestSha256) { if (manifestSha256 !== expectedManifestSha256) fail(`manifest sha256 ${manifestSha256} != expected ${expectedManifestSha256}`); }
  else if (!allowUnpinned) fail("no expected manifest sha256 given (refusing an unpinned bundle)");
  const manifest = JSON.parse(manifestBuf);
  if (releaseId && manifest.release_id !== releaseId) fail(`release_id ${manifest.release_id} != ${releaseId}`);
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(manifest.release_id ?? "")) fail("invalid release_id");
  if (!/^[0-9a-f]{64}$/.test(manifest.base_snapshot_sha256 ?? "")) fail("invalid base_snapshot_sha256");
  if (!manifest.prerequisites?.schema_migration) fail("missing prerequisites.schema_migration");
  const listed = (manifest.artifacts ?? []).map(a => a.file);
  if (JSON.stringify([...listed].sort()) !== JSON.stringify([...BUNDLE_FILES].sort())) fail(`artifact list ${listed} != ${BUNDLE_FILES}`);
  const data = {};
  for (const a of manifest.artifacts) {
    const buf = await readFile(path.join(dir, a.file));
    if (sha256(buf) !== a.sha256) fail(`${a.file} sha256 mismatch (corrupted or modified artifact)`);
    const rows = JSON.parse(buf);
    if (!Array.isArray(rows) || rows.length !== a.records) fail(`${a.file} record count ${rows.length} != manifest ${a.records}`);
    data[a.file.replace(/\.json$/, "")] = rows;
  }
  const { parks, park_source_refs: refs, aliases, tombstones, reviews, rejections } = data;
  const counts = {
    parks: parks.length, osm_backed_parks: parks.filter(p => p.osm_id).length, park_source_refs: refs.length,
    aliases: aliases.length, tombstones: tombstones.length,
    tombstones_taxonomy_review: tombstones.filter(t => t.status === "taxonomy_review").length, tombstones_non_park: tombstones.filter(t => t.status === "non_park").length,
    tombstone_refs: tombstones.reduce((n, t) => n + t.source_refs.length, 0),
    reviews: reviews.length, reviews_keep_review: reviews.filter(r => r.review_reason !== "taxonomy_ambiguous_physical_park").length, reviews_taxonomy: reviews.filter(r => r.review_reason === "taxonomy_ambiguous_physical_park").length,
    rejections: rejections.length
  };
  for (const [k, v] of Object.entries(manifest.expected_counts)) if (counts[k] !== v) fail(`count ${k}=${counts[k]} != manifest expected ${v}`);
  if (expectedCounts) for (const [k, v] of Object.entries(expectedCounts)) if (counts[k] !== v || manifest.expected_counts[k] !== v) fail(`count ${k}=${counts[k]} (manifest ${manifest.expected_counts[k]}) != frozen ${v}`);
  // identities
  const ids = new Set(), osm = new Set();
  for (const p of parks) {
    if (!UUID.test(p.id)) fail(`invalid park id ${p.id}`);
    if (ids.has(p.id)) fail(`duplicate park id ${p.id}`); ids.add(p.id);
    if (p.osm_id) { if (osm.has(p.osm_id)) fail(`duplicate osm_id ${p.osm_id}`); osm.add(p.osm_id); }
    if (!p.name || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || p.latitude < 35 || p.latitude > 43 || p.longitude < 25 || p.longitude > 45) fail(`invalid park row ${p.id}`);
  }
  const liveRefs = new Set();
  for (const r of refs) {
    const k = refKey(r);
    if (liveRefs.has(k)) fail(`duplicate live source ref ${k}`); liveRefs.add(k);
    if (!ids.has(r.park_id)) fail(`source ref ${k} points to a park not in the bundle`);
  }
  for (const p of parks) if (p.osm_id && !liveRefs.has(`osm:${p.osm_id}`)) fail(`OSM park ${p.id} lacks its osm source ref`);
  // lifecycle graph
  const retired = new Set();
  for (const e of [...aliases, ...tombstones]) {
    if (!UUID.test(e.retired_park_id)) fail(`invalid retired id ${e.retired_park_id}`);
    if (retired.has(e.retired_park_id)) fail(`retired id ${e.retired_park_id} appears twice (alias/tombstone exclusivity)`);
    retired.add(e.retired_park_id);
    if (ids.has(e.retired_park_id)) fail(`retired id ${e.retired_park_id} is also a live park`);
  }
  for (const a of aliases) {
    if (a.canonical_park_id === a.retired_park_id) fail(`self alias ${a.retired_park_id}`);
    if (!ids.has(a.canonical_park_id)) fail(`alias survivor ${a.canonical_park_id} missing from live parks`);
    if (retired.has(a.canonical_park_id)) fail(`alias chain/cycle through ${a.canonical_park_id}`);
    for (const r of a.source_refs_preserved) if (!liveRefs.has(refKey(r))) fail(`alias ${a.retired_park_id} preserved ref ${refKey(r)} is not a live ref`);
  }
  const tombRefs = new Set();
  for (const t of tombstones) {
    if (!TOMBSTONE_STATUSES.includes(t.status)) fail(`tombstone status ${t.status}`);
    for (const r of t.source_refs) { const k = refKey(r); if (tombRefs.has(k) || liveRefs.has(k)) fail(`tombstone ref ${k} held twice`); tombRefs.add(k); }
  }
  // reviews / rejections identity: unique, never live
  const seen = new Set();
  for (const [name, rows] of [["review", reviews], ["rejection", rejections]]) for (const r of rows) {
    const k = `${name}:${refKey(r)}`;
    if (seen.has(k)) fail(`duplicate ${name} ${refKey(r)}`); seen.add(k);
    if (liveRefs.has(refKey(r))) fail(`${name} ${refKey(r)} is also a live source ref`);
    if (!r.source_code || !r.external_id) fail(`${name} without identity`);
  }
  for (const r of reviews) if (seen.has(`rejection:${refKey(r)}`)) fail(`${refKey(r)} is both a review and a rejection`);
  return { manifest, manifestSha256, data, counts };
}

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { clean } from "./park-enrichment.mjs";
import { nameFlags } from "./review-name-evidence.mjs";
import { loadProvinceRegions, officialProvinceNames } from "./province-boundaries.mjs";

// Builds a HYPOTHETICAL canonical preview from the review-resolution proposal
// into a SEPARATE file, then recomputes every global invariant independently
// from the two files on disk. Never writes the real canonical preview / DB.
//   node scripts/build-review-resolution-preview.mjs
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
// Optional parametrisation (defaults unchanged): --base=<file> --resolution=<file> --out-preview=<file> --out-invariants=<file>  (all rel .cache)
const argv = process.argv.slice(2);
const argVal = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const BASE = argVal("base") ?? "nationwide-canonical-preview.json";
const OUT_PREVIEW = argVal("out-preview") ?? "review-resolution/hypothetical-canonical-preview.json";
const OUT_INV = argVal("out-invariants") ?? "review-resolution/hypothetical-invariants.json";
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const resolution = await J(argVal("resolution") ?? "review-resolution/resolution.json");
const base = await J(BASE);
const { configs } = await J("../../municipal-ingestion-configs.json");
const cfgOf = Object.fromEntries(configs.map(c => [c.source_code, c]));

function deterministicUuid(value) { // identical to municipal-ingestion-engine.mjs
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-");
}
const refOf = (sc, id) => { const c = cfgOf[sc]; return { source_code: sc, external_id: String(id), source_url: `${c.dataset_url}#${c.external_id_url_param}_${id}` }; };

const parks = structuredClone(base.parks);
const byId = new Map(parks.map(p => [p.id, p]));
const refKeys = new Set(parks.flatMap(p => (p.source_refs ?? []).map(r => `${r.source_code}:${r.external_id}`)));
const applied = { new: 0, matched: 0, duplicate_attached: 0, refs_added: 0 };
const errors = [];
const addRef = (park, ref) => { const k = `${ref.source_code}:${ref.external_id}`; if (refKeys.has(k)) { errors.push(`duplicate source ref ${k}`); return; } refKeys.add(k); (park.source_refs ??= []).push(ref); applied.refs_added++; };

const newIdBySource = new Map();     // source_code:external_id -> new canonical id
for (const r of resolution.records.filter(x => x.proposed_outcome === "NEW_CANONICAL_SAFE")) {
  const c = cfgOf[r.source_code];
  const id = deterministicUuid(`${c.id_namespace}:${r.source_external_id}`);
  if (byId.has(id)) { errors.push(`new id collision ${id}`); continue; }
  const nm = clean(r.name) || "İsimsiz park";
  const park = { id, osm_id: null, name: nm, city: r.province, district: r.district ?? "", latitude: r.latitude, longitude: r.longitude, source: c.source_display_name,
    name_status: nameFlags(nm).generic ? "missing" : "municipal", name_source: c.source_display_name, name_source_url: c.dataset_url, source_refs: [], provenance_metadata: { source_name_raw: r.name, district_method: "inherited from the original review record", created_by: "review_resolution_preview" } };
  parks.push(park); byId.set(id, park); addRef(park, refOf(r.source_code, r.source_external_id)); newIdBySource.set(`${r.source_code}:${r.source_external_id}`, id); applied.new++;
}
for (const r of resolution.records) {
  if (r.proposed_outcome === "MATCH_EXISTING") {
    const t = byId.get(r.target_canonical_id); if (!t) { errors.push(`match target missing ${r.target_canonical_id}`); continue; }
    addRef(t, refOf(r.source_code, r.source_external_id)); applied.matched++;
  } else if (r.proposed_outcome === "REJECT_DUPLICATE") {
    const tid = r.provenance_attach_to_canonical_id ?? newIdBySource.get(`${r.source_code}:${r.provenance_attach_to_new_source_external_id}`) ?? null;
    const t = tid ? byId.get(tid) : null;
    if (!t) { errors.push(`duplicate provenance target missing for ${r.source_code}:${r.source_external_id}`); continue; }
    addRef(t, refOf(r.source_code, r.source_external_id)); applied.duplicate_attached++;
  }
}
if (errors.length) throw new Error(`preview build errors: ${errors.slice(0, 5).join("; ")}`);
const out = { ...base, generatedAt: new Date().toISOString(), mode: "nationwide-canonical-preview-HYPOTHETICAL-review-resolution", summary: { ...base.summary, totalCanonicalParks: parks.length }, parks };
await writeFile(new URL(OUT_PREVIEW, cache), JSON.stringify(out));

/* ---------- independent invariant recompute (from the files on disk) ---------- */
const A = await J(OUT_PREVIEW), B = await J(BASE);
const official = officialProvinceNames(await loadProvinceRegions(new URL("../data/provinces.geojson", import.meta.url)));
const ids = new Set(), osm = new Set(), refs = new Set();
let dupId = 0, dupOsm = 0, dupRef = 0, badCoord = 0, badProv = 0;
for (const p of A.parks) {
  if (ids.has(p.id)) dupId++; ids.add(p.id);
  if (p.osm_id) { if (osm.has(p.osm_id)) dupOsm++; osm.add(p.osm_id); }
  for (const r of p.source_refs ?? []) { const k = `${r.source_code}:${r.external_id}`; if (refs.has(k)) dupRef++; refs.add(k); }
  if (!(p.latitude >= 35 && p.latitude <= 43 && p.longitude >= 25 && p.longitude <= 45)) badCoord++;
  if (!official.has(p.city)) badProv++;
}
const aById = new Map(A.parks.map(p => [p.id, p]));
let missing = 0, osmIdChanges = 0, mutated = 0, refsLost = 0;
for (const b of B.parks) {
  const a = aById.get(b.id); if (!a) { missing++; continue; }
  if (a.osm_id !== b.osm_id) osmIdChanges++;
  if (a.name !== b.name || a.latitude !== b.latitude || a.longitude !== b.longitude || a.city !== b.city || a.district !== b.district) mutated++;
  if (JSON.stringify(b.source_refs ?? []) !== JSON.stringify((a.source_refs ?? []).slice(0, (b.source_refs ?? []).length))) refsLost++;
}
const newN = resolution.records.filter(x => x.proposed_outcome === "NEW_CANONICAL_SAFE").length;
const result = {
  baseline_canonical: B.parks.length, hypothetical_canonical: A.parks.length, expected: B.parks.length + newN, matches_expected: A.parks.length === B.parks.length + newN,
  applied, remaining_review_backlog: resolution.records.filter(x => x.proposed_outcome === "KEEP_REVIEW").length,
  invariants: { duplicate_canonical_id: dupId, duplicate_osm_id: dupOsm, duplicate_source_ref: dupRef, invalid_coordinates: badCoord, province_outside_official_81: badProv, osm_deterministic_id_changes: osmIdChanges, preexisting_parks_missing: missing, preexisting_identity_fields_mutated: mutated, prior_source_refs_lost_or_changed: refsLost, osm_backed_before: B.parks.filter(p => p.osm_id).length, osm_backed_after: A.parks.filter(p => p.osm_id).length },
  total_source_refs_before: B.parks.reduce((n, p) => n + (p.source_refs?.length ?? 0), 0), total_source_refs_after: A.parks.reduce((n, p) => n + (p.source_refs?.length ?? 0), 0),
  real_canonical_preview_untouched: JSON.stringify(B.summary) === JSON.stringify(base.summary)
};
await writeFile(new URL(OUT_INV, cache), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));

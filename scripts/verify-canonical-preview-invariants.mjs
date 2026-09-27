import { readFile } from "node:fs/promises";
import { loadProvinceRegions, officialProvinceNames } from "./province-boundaries.mjs";
// Independent invariant verifier: compares a HYPOTHETICAL preview against its base file.
//   node scripts/verify-canonical-preview-invariants.mjs --base=<f> --preview=<f> [--preserve-source=<code>] [--retired=<lifecycle.json>]   (paths rel .cache)
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
const argv = process.argv.slice(2), val = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const B = await J(val("base")), A = await J(val("preview"));
const official = officialProvinceNames(await loadProvinceRegions(new URL("../data/provinces.geojson", import.meta.url)));
const retired = val("retired") ? new Set((await J(val("retired"))).retired.map(r => r.old_canonical_id)) : new Set();
const ids = new Set(), osm = new Set(), refs = new Map(); let dupId = 0, dupOsm = 0, dupRef = 0, badCoord = 0, badProv = 0;
for (const p of A.parks) {
  if (ids.has(p.id)) dupId++; ids.add(p.id);
  if (p.osm_id) { if (osm.has(p.osm_id)) dupOsm++; osm.add(p.osm_id); }
  for (const r of p.source_refs ?? []) { const k = `${r.source_code}:${r.external_id}`; if (refs.has(k)) dupRef++; refs.set(k, p.id); }
  if (!(p.latitude >= 35 && p.latitude <= 43 && p.longitude >= 25 && p.longitude <= 45)) badCoord++;
  if (!official.has(p.city)) badProv++;
}
const aById = new Map(A.parks.map(p => [p.id, p]));
let missingNotRetired = 0, retiredPresent = 0, osmIdChanges = 0, mutated = 0, refsLost = 0, unchangedOthers = 0;
const bRefs = new Map(); for (const p of B.parks) for (const r of p.source_refs ?? []) bRefs.set(`${r.source_code}:${r.external_id}`, p.id);
for (const b of B.parks) {
  const a = aById.get(b.id);
  if (!a) { if (!retired.has(b.id)) missingNotRetired++; continue; }
  if (retired.has(b.id)) retiredPresent++;
  if (a.osm_id !== b.osm_id) osmIdChanges++;
  if (a.name !== b.name || a.latitude !== b.latitude || a.longitude !== b.longitude || a.city !== b.city || a.district !== b.district) mutated++;
  const hadKeys = (b.source_refs ?? []).map(r => `${r.source_code}:${r.external_id}`), haveKeys = new Set((a.source_refs ?? []).map(r => `${r.source_code}:${r.external_id}`));
  if (!hadKeys.every(k => haveKeys.has(k))) refsLost++;
  if (JSON.stringify(a) === JSON.stringify(b)) unchangedOthers++;
}
const lostRefs = [...bRefs.keys()].filter(k => !refs.has(k));
const preserve = val("preserve-source");
const out = {
  base_total: B.parks.length, preview_total: A.parks.length, delta: A.parks.length - B.parks.length,
  duplicate_canonical_id: dupId, duplicate_osm_id: dupOsm, duplicate_source_ref: dupRef, invalid_coordinates: badCoord, province_outside_official_81: badProv,
  osm_deterministic_id_changes: osmIdChanges, base_parks_missing_and_not_retired: missingNotRetired, retired_ids_still_present: retiredPresent,
  base_identity_fields_mutated: mutated, base_parks_losing_refs_without_being_retired: refsLost, source_refs_lost_overall: lostRefs.length,
  osm_backed_base: B.parks.filter(p => p.osm_id).length, osm_backed_preview: A.parks.filter(p => p.osm_id).length,
  source_refs_base: bRefs.size, source_refs_preview: refs.size,
  ...(preserve ? { [`${preserve}_refs_base`]: [...bRefs.keys()].filter(k => k.startsWith(preserve + ":")).length, [`${preserve}_refs_preview`]: [...refs.keys()].filter(k => k.startsWith(preserve + ":")).length, [`${preserve}_refs_lost`]: lostRefs.filter(k => k.startsWith(preserve + ":")).length } : {}),
  per_source_municipal_only_preview: Object.fromEntries(["izmir_kent_rehberi", "konya_acikveri_parklar", "ordu_acikveri_parklari", "trabzon_acikveri_parklar", "kayseri_kocasinan_park_ve_bahceler", "van_buyuksehir_parklar"].map(c => [c, A.parks.filter(p => !p.osm_id && (p.source_refs ?? []).some(r => r.source_code === c)).length])),
  per_source_municipal_only_base: Object.fromEntries(["izmir_kent_rehberi", "konya_acikveri_parklar", "ordu_acikveri_parklari", "trabzon_acikveri_parklar", "kayseri_kocasinan_park_ve_bahceler", "van_buyuksehir_parklar"].map(c => [c, B.parks.filter(p => !p.osm_id && (p.source_refs ?? []).some(r => r.source_code === c)).length]))
};
console.log(JSON.stringify(out, null, 1));

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { clean, distanceMeters, nameKey } from "./park-enrichment.mjs";
import { representativePoint } from "./polygon-geometry.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";
import { loadDistrictRegions, districtsForProvince, districtsContaining, nearestDistrict } from "./district-boundaries.mjs";
import { polygonRelation } from "./polygon-relations.mjs";
import { nameRelationship, hasNameEvidence, nameFlags } from "./review-name-evidence.mjs";

// Stage 1-2 of the physical-park consolidation for a POLYGON municipal source:
// full inventory (matched / new / review status, polygons, spatial district) and
// exhaustive pairwise relationship evidence between nearby records. Read-only.
//   node scripts/analyze-polygon-source-inventory.mjs <source_code>
const sc = process.argv[2] ?? "ordu_acikveri_parklari";
const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
const J = async u => JSON.parse(await readFile(new URL(u, cache), "utf8"));
const { configs } = await J("../../municipal-ingestion-configs.json");
const cfg = configs.find(c => c.source_code === sc);
const canonical = await J("nationwide-canonical-preview.json");
const backlog = await J("municipal-review-backlog.json");
const raw = await J(`${cfg.cache_dir}/${cfg.raw_filename}`);
const provinceRegions = await loadProvinceRegions(new URL("../data/provinces.geojson", import.meta.url));
const districtRegions = await loadDistrictRegions(new URL("../data/park-enrichment/districts.geojson", import.meta.url));
const scoped = districtsForProvince(districtRegions, provinceRegions, cfg.province, provincesContaining);

const canonByRef = new Map();
for (const p of canonical.parks) for (const r of p.source_refs ?? []) if (r.source_code === sc) canonByRef.set(String(r.external_id), p);
const reviewIds = new Set(backlog.records.filter(r => r.source_code === sc).map(r => String(r.external_id)));

const records = [], invalid = [];
for (const f of raw.features) {
  const id = f.properties?.[cfg.id_field];
  const polys = f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates : f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : [];
  if (id === null || id === undefined || id === "" || !polys.length) { invalid.push({ id: id ?? null, name: f.properties?.[cfg.name_field] ?? null }); continue; }
  const rp = representativePoint(polys);
  const contains = districtsContaining(scoped, rp.lon, rp.lat);
  const nd = contains.length ? null : nearestDistrict(scoped, rp.lon, rp.lat);
  const canon = canonByRef.get(String(id)) ?? null;
  records.push({
    id: String(id), name: clean(f.properties[cfg.name_field]) || "İsimsiz park", source_props: f.properties, polys,
    latitude: rp.lat, longitude: rp.lon, district: contains.length === 1 ? contains[0].name : nd && nd.distance_m <= 3000 ? nd.name : null,
    status: canon ? (canon.osm_id ? "accepted_osm_matched" : "accepted_municipal_new") : reviewIds.has(String(id)) ? "review" : "other",
    canonical_id: canon?.id ?? null, canonical_osm_id: canon?.osm_id ?? null
  });
}
const districtNames = new Set(scoped.map(d => nameKey(d.name)));

// pairwise evidence for records whose bounding areas are near each other
const pairs = [];
for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
  const a = records[i], b = records[j];
  const rd = distanceMeters(a, b);
  if (rd > 3000) continue;
  const rel = polygonRelation(a.polys, b.polys);
  if (rel.boundary_gap_m > 1000) continue;
  const nr = nameRelationship(a.name, b.name);
  pairs.push({ a: a.id, b: b.id, rep_distance_m: Math.round(rd * 10) / 10, ...rel, same_name_key: nameKey(a.name) === nameKey(b.name), name_kind: nr.kind, name_evidence: hasNameEvidence(nr), same_district: a.district && b.district ? a.district === b.district : null });
}
const out = new URL("ordu-consolidation/", cache);
await mkdir(out, { recursive: true });
const inv = { source_code: sc, generated_at: new Date().toISOString(), raw_features: raw.features.length, invalid_records: invalid, usable_records: records.length, by_status: records.reduce((o, r) => (o[r.status] = (o[r.status] ?? 0) + 1, o), {}), district_names: [...districtNames], by_district: records.reduce((o, r) => (o[r.district ?? "?"] = (o[r.district ?? "?"] ?? 0) + 1, o), {}), name_classes: records.reduce((o, r) => { const f = nameFlags(r.name); const k = f.placeholder ? "placeholder" : f.generic ? "generic" : "specific"; o[k] = (o[k] ?? 0) + 1; return o; }, {}), pair_count: pairs.length,
  records: records.map(({ polys, source_props, ...r }) => ({ ...r, source_id: r.id, vertices: polys.flat(2).length, area_m2_source: source_props.ALANI ?? null, layer: source_props.KATMAN ?? null })) };
await writeFile(new URL("inventory.json", out), JSON.stringify(inv, null, 1));
await writeFile(new URL("pairs.json", out), JSON.stringify(pairs));

// ---- empirical distributions
const bucket = g => g === 0 ? "0 (intersect/touch)" : g <= 1 ? "<=1" : g <= 2 ? "<=2" : g <= 5 ? "<=5" : g <= 10 ? "<=10" : g <= 20 ? "<=20" : g <= 30 ? "<=30" : g <= 50 ? "<=50" : g <= 100 ? "<=100" : g <= 150 ? "<=150" : g <= 250 ? "<=250" : g <= 500 ? "<=500" : ">500";
const order = ["0 (intersect/touch)", "<=1", "<=2", "<=5", "<=10", "<=20", "<=30", "<=50", "<=100", "<=150", "<=250", "<=500", ">500", "none"];
const byId = new Map(records.map(r => [r.id, r]));
const nearest = (rec, filter) => { let best = null; for (const p of pairs) { const other = p.a === rec.id ? p.b : p.b === rec.id ? p.a : null; if (!other || !filter(p, byId.get(other))) continue; if (best === null || p.boundary_gap_m < best) best = p.boundary_gap_m; } return best; };
const hist = f => { const h = {}; for (const r of records) { const g = nearest(r, f); const k = g === null ? "none" : bucket(g); h[k] = (h[k] ?? 0) + 1; } return Object.fromEntries(order.filter(k => h[k]).map(k => [k, h[k]])); };
const specific = r => { const f = nameFlags(r.name); return !f.generic && !f.placeholder; };
console.log(JSON.stringify({ usable: records.length, by_status: inv.by_status, by_district: inv.by_district, name_classes: inv.name_classes, pairs: pairs.length }));
console.log("\nA) nearest SAME-NAME (name evidence) record, boundary gap — all records:"); console.log(JSON.stringify(hist((p) => p.name_evidence)));
console.log("\nB) nearest DIFFERENT-NAME record, boundary gap (context for normal adjacency of distinct parks):"); console.log(JSON.stringify(hist((p) => !p.name_evidence)));
console.log("\nC) same-name pairs by relation kind:", JSON.stringify(pairs.filter(p => p.name_evidence).reduce((o, p) => { const k = p.intersects ? "intersects" : p.touches ? "touches" : "gap"; o[k] = (o[k] ?? 0) + 1; return o; }, {})));
console.log("D) different-name pairs that INTERSECT or TOUCH:", pairs.filter(p => !p.name_evidence && (p.intersects || p.touches)).length);

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { clean, distanceMeters, nameKey } from "./park-enrichment.mjs";
import { pointInPolygonRings, representativePoint } from "./polygon-geometry.mjs";
import { nameRelationship, hasNameEvidence, nameFlags } from "./review-name-evidence.mjs";

// Generic, read-only PREVIEW resolver for the municipal review backlog.
// Every review record ends in exactly one of:
//   MATCH_EXISTING / NEW_CANONICAL_SAFE / REJECT_DUPLICATE / REJECT_NON_PARK / KEEP_REVIEW
// using explicit evidence flags (no confidence score, no per-id rules).
// Never modifies the backlog, the canonical preview, or any DB.
//   node scripts/resolve-municipal-review-backlog.mjs

const cache = new URL("../data/park-enrichment/.cache/", import.meta.url);
// Optional parametrisation (defaults reproduce the original behaviour exactly):
//   --canonical=<file rel .cache> --backlog=<file rel .cache> --out=<dir rel .cache> --cluster-override=<file rel .cache>
const argv = process.argv.slice(2);
const argVal = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const outDir = new URL(`${(argVal("out") ?? "review-resolution").replace(/\/?$/, "/")}`, cache);
await mkdir(outDir, { recursive: true });
const J = async (u, base) => JSON.parse(await readFile(new URL(u, base), "utf8"));

const backlog = await J(argVal("backlog") ?? "municipal-review-backlog.json", cache);
const canonical = await J(argVal("canonical") ?? "nationwide-canonical-preview.json", cache);
const clusterOverride = argVal("cluster-override") ? await J(argVal("cluster-override"), cache) : null;
const { configs } = await J("../../municipal-ingestion-configs.json", cache);
const rcfg = await J("../../municipal-review-resolution-config.json", cache);
const T = rcfg.thresholds;
const NONPARK = new RegExp(rcfg.non_park_keywords, "iu");
const parkWord = t => /(?<![\p{L}\p{N}])park(lar)?[ıi]?(?![\p{L}\p{N}])/u.test(clean(t).toLocaleLowerCase("tr"));

/* ---------------- geometry helpers ---------------- */
const KY = 110540;
const kxAt = lat => 111320 * Math.cos((lat * Math.PI) / 180);
function toPolys(g) { if (!g) return []; if (g.type === "Polygon") return [g.coordinates]; if (g.type === "MultiPolygon") return g.coordinates; return []; }
function segDist(lon, lat, a, b) {
  const kx = kxAt(lat);
  const px = 0, py = 0, ax = (a[0] - lon) * kx, ay = (a[1] - lat) * KY, bx = (b[0] - lon) * kx, by = (b[1] - lat) * KY;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function pointPolyDist(lon, lat, poly) {
  if (pointInPolygonRings(lon, lat, poly)) return 0;
  let d = Infinity;
  for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) d = Math.min(d, segDist(lon, lat, ring[i], ring[i + 1]));
  return d;
}
function pointPolysDist(lon, lat, polys) { let d = Infinity; for (const p of polys) d = Math.min(d, pointPolyDist(lon, lat, p)); return d; }
function vertices(poly) { return poly.flatMap(r => r); }
function polysGap(A, B) {           // min vertex-to-polygon gap (0 = overlap)
  let d = Infinity;
  for (const a of A) for (const v of vertices(a).filter((_, i) => i % 1 === 0)) { for (const b of B) { d = Math.min(d, pointPolyDist(v[0], v[1], b)); if (d === 0) return 0; } }
  for (const b of B) for (const v of vertices(b)) { for (const a of A) { d = Math.min(d, pointPolyDist(v[0], v[1], a)); if (d === 0) return 0; } }
  return d;
}

/* ---------------- canonical + OSM polygons ---------------- */
const provincesOfInterest = new Set(backlog.records.map(r => r.province));
const parks = canonical.parks.filter(p => provincesOfInterest.has(p.city));
const osmPoly = new Map();
{
  const mp = await J("geofabrik/multipolygons.geojson", cache);
  const byNum = new Map();
  for (const f of mp.features) { const k = String(f.properties.osm_id); if (!byNum.has(k)) byNum.set(k, []); byNum.get(k).push(f.geometry.coordinates); }
  for (const p of parks) {
    if (!p.osm_id || p.osm_id.startsWith("node/")) continue;
    const cands = byNum.get(p.osm_id.split("/")[1]) ?? [];
    const hit = cands.find(polys => polys.some(poly => pointInPolygonRings(p.longitude, p.latitude, poly))) ?? cands[0];
    if (hit) osmPoly.set(p.id, hit);
  }
}
const canonById = new Map(canonical.parks.map(p => [p.id, p]));
// Tokens that are too common among local park names to count as distinctive (data-driven).
const commonTokens = (() => {
  const freq = new Map();
  for (const p of parks) for (const t of new Set(clean(p.name).toLocaleLowerCase("tr").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").split(/[^a-z0-9]+/).filter(Boolean))) freq.set(t, (freq.get(t) ?? 0) + 1);
  return new Set([...freq].filter(([, n]) => n >= 15).map(([t]) => t));
})();
const NR = (a, b) => nameRelationship(a, b, { commonTokens });
const refToCanon = new Map();
for (const p of canonical.parks) for (const r of p.source_refs ?? []) refToCanon.set(`${r.source_code}:${r.external_id}`, p.id);
const GRID = 0.01;
const grid = new Map();
for (const p of parks) { const k = `${Math.floor(p.latitude / GRID)}:${Math.floor(p.longitude / GRID)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
function nearbyCanonical(lat, lon, m) {
  const r = Math.ceil(m / 1000 / 111 / GRID) + 1, ci = Math.floor(lat / GRID), cj = Math.floor(lon / GRID), out = [];
  for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (const p of grid.get(`${i}:${j}`) ?? []) out.push(p);
  return out;
}

/* ---------------- source records (all candidates of each source) ---------------- */
const reviewKey = r => `${r.source_code}:${r.external_id}`;
const reviewSet = new Set(backlog.records.map(reviewKey));
const sources = {};
for (const sc of Object.keys(backlog.bySource)) {
  const cfg = configs.find(c => c.source_code === sc);
  const raw = await J(`${cfg.cache_dir}/${cfg.raw_filename}`, cache);
  const recs = [];
  const seen = new Set();
  for (const f of raw.features) {
    const props = f.properties ?? {};
    const rawId = props[cfg.id_field];
    if (rawId === null || rawId === undefined || rawId === "") continue;
    const id = String(rawId);
    if (seen.has(id)) continue;
    let pt = null, polys = [];
    if (f.geometry?.type === "Point") pt = { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] };
    else { polys = toPolys(f.geometry); try { if (polys.length) { const rp = representativePoint(polys); pt = { latitude: rp.lat, longitude: rp.lon }; } } catch { /* skip */ } }
    if (!pt) continue;
    if (cfg.taxonomy_field && !cfg.allowed_taxonomy_values?.includes(props[cfg.taxonomy_field])) continue;
    if (cfg.taxonomy_rule === "name_contains_park_word" && !parkWord(props[cfg.name_field])) continue;
    seen.add(id);
    const status = refToCanon.has(`${sc}:${id}`) ? "accepted" : reviewSet.has(`${sc}:${id}`) ? "review" : "other";
    recs.push({ id, key: `${sc}:${id}`, name: clean(props[cfg.name_field]) || "İsimsiz park", latitude: pt.latitude, longitude: pt.longitude, polys, props, status, canonical_id: refToCanon.get(`${sc}:${id}`) ?? null });
  }
  sources[sc] = { cfg, recs, byId: new Map(recs.map(r => [r.id, r])), tier2: cfg.osm_match_tiers_m[1], polygonSource: recs.some(r => r.polys.length) };
}

/* ---------------- within-source clustering / fragmentation ---------------- */
function srcGap(a, b) {
  if (a.polys.length && b.polys.length) return polysGap(a.polys, b.polys);
  if (a.polys.length) return pointPolysDist(b.longitude, b.latitude, a.polys);
  if (b.polys.length) return pointPolysDist(a.longitude, a.latitude, b.polys);
  return distanceMeters(a, b);
}
const clusters = {};      // source_code -> { of: Map(key -> clusterId), info: Map(clusterId -> {...}) }
const fragmentation = {};
for (const [sc, S] of Object.entries(sources)) {
  const parent = new Map(S.recs.map(r => [r.key, r.key]));
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const links = [], amb = new Map(S.recs.map(r => [r.key, []]));
  const ordered = [...S.recs];
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      if (Math.abs(a.latitude - b.latitude) > 0.004 || Math.abs(a.longitude - b.longitude) > 0.006) continue;
      const pd = distanceMeters(a, b); if (pd > 600) continue;
      const gap = srcGap(a, b);
      const overlap = a.polys.length && b.polys.length ? gap === 0 : pd <= T.identical_point_m;
      const rel = NR(a.name, b.name);
      const nameEv = hasNameEvidence(rel);
      const weakEither = nameFlags(a.name).generic || nameFlags(b.name).generic || nameFlags(a.name).placeholder || nameFlags(b.name).placeholder;
      if (overlap && (nameEv || weakEither)) links.push([a.key, b.key, "overlap"]);
      else if (overlap) { amb.get(a.key).push({ with: b.id, why: "overlap_but_distinct_specific_names" }); amb.get(b.key).push({ with: a.id, why: "overlap_but_distinct_specific_names" }); }
      else if (nameEv && gap <= T.fragment_gap_m) links.push([a.key, b.key, "same_name_adjacent"]);
      else if (nameEv && gap <= T.namesake_ambiguous_gap_m) { amb.get(a.key).push({ with: b.id, gap_m: Math.round(gap), why: "same_name_nearby_not_adjacent" }); amb.get(b.key).push({ with: a.id, gap_m: Math.round(gap), why: "same_name_nearby_not_adjacent" }); }
    }
  }
  for (const [a, b] of links) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  const members = new Map();
  for (const r of S.recs) { const c = find(r.key); if (!members.has(c)) members.set(c, []); members.get(c).push(r); }
  const of = new Map(), info = new Map();
  const stats = { clusters_size_ge2: 0, ONE_PHYSICAL_PARK_FRAGMENTED: 0, AMBIGUOUS: 0, records_in_clusters: 0, largest: [], distinct_namesake_groups: 0 };
  for (const [c, ms] of members) {
    const hasAmb = ms.some(m => amb.get(m.key).length);
    const cls = ms.length >= 2 ? (hasAmb ? "AMBIGUOUS" : "ONE_PHYSICAL_PARK_FRAGMENTED") : "SINGLETON";
    info.set(c, { size: ms.length, class: cls, members: ms.map(m => m.id) });
    for (const m of ms) of.set(m.key, c);
    if (ms.length >= 2) { stats.clusters_size_ge2++; stats[cls]++; stats.records_in_clusters += ms.length; stats.largest.push({ name: ms[0].name, size: ms.length, class: cls, statuses: ms.reduce((o, m) => (o[m.status] = (o[m.status] ?? 0) + 1, o), {}) }); }
  }
  stats.largest.sort((x, y) => y.size - x.size); stats.largest = stats.largest.slice(0, 10);
  // namesake groups: same non-weak name, >= 2 components (DISTINCT_PARKS)
  const byName = new Map();
  for (const r of S.recs) { if (nameFlags(r.name).generic || nameFlags(r.name).placeholder) continue; const k = nameKey(r.name); if (!byName.has(k)) byName.set(k, new Set()); byName.get(k).add(of.get(r.key)); }
  stats.distinct_namesake_groups = [...byName.values()].filter(s => s.size >= 2).length;
  // per same-name group: ONE_PHYSICAL_PARK_FRAGMENTED / DISTINCT_PARKS / AMBIGUOUS
  const groupClass = { ONE_PHYSICAL_PARK_FRAGMENTED: 0, DISTINCT_PARKS: 0, AMBIGUOUS: 0 };
  const byNameRecs = new Map();
  for (const r of S.recs) { if (nameFlags(r.name).generic || nameFlags(r.name).placeholder) continue; const k = nameKey(r.name); if (!byNameRecs.has(k)) byNameRecs.set(k, []); byNameRecs.get(k).push(r); }
  for (const rs of byNameRecs.values()) {
    if (rs.length < 2) continue;
    const comps = new Set(rs.map(r => of.get(r.key)));
    const anyAmb = rs.some(r => amb.get(r.key).some(a => a.why === "same_name_nearby_not_adjacent"));
    if (comps.size === 1) groupClass.ONE_PHYSICAL_PARK_FRAGMENTED++;
    else if (anyAmb) groupClass.AMBIGUOUS++;
    else groupClass.DISTINCT_PARKS++;
  }
  stats.same_name_group_class = groupClass;
  // accepted (already canonical) records that are fragments of a multi-record cluster
  stats.accepted_records_in_multi_record_clusters = S.recs.filter(r => r.status === "accepted" && info.get(of.get(r.key)).size >= 2).length;
  stats.accepted_distinct_canonical_in_multi_record_clusters = new Set(S.recs.filter(r => r.status === "accepted" && info.get(of.get(r.key)).size >= 2 && r.canonical_id && !canonById.get(r.canonical_id)?.osm_id).map(r => r.canonical_id)).size;
  clusters[sc] = { of, info, amb };
  if (clusterOverride?.source_code === sc) {
    // Physical-park clusters (strong polygon-continuity components) replace the crude clustering:
    // a component of >=2 records is ONE physical park; records of ambiguous GROUPS (components linked
    // only by gray-zone gaps) carry an ambiguity marker that blocks NEW / spatial-only decisions.
    const of2 = new Map(), info2 = new Map(), amb2 = new Map();
    for (const r of S.recs) {
      const o = clusterOverride.records[r.id];
      if (!o) { of2.set(r.key, `solo:${r.id}`); info2.set(`solo:${r.id}`, { size: 1, class: "SINGLETON", members: [r.id] }); amb2.set(r.key, []); continue; }
      of2.set(r.key, o.cluster_id);
      info2.set(o.cluster_id, { size: o.size, class: o.size >= 2 ? "ONE_PHYSICAL_PARK_FRAGMENTED" : "SINGLETON", members: o.members });
      const ambs = [];
      if (o.group_class === "AMBIGUOUS_CLUSTER") ambs.push({ why: "ambiguous physical-park group (components linked only by gray-zone gaps)" });
      if (o.nearest_other_component_same_name_gap_m !== null && o.nearest_other_component_same_name_gap_m !== undefined && o.nearest_other_component_same_name_gap_m <= T.namesake_ambiguous_gap_m) ambs.push({ why: `same-name record in another component within ${o.nearest_other_component_same_name_gap_m} m (fragment vs namesake undecidable)` });
      amb2.set(r.key, ambs);
    }
    clusters[sc] = { of: of2, info: info2, amb: amb2 };
  }
  fragmentation[sc] = { polygon_source: S.polygonSource, candidates: S.recs.length, ...stats };
}

/* ---------------- evidence per review record ---------------- */
function districtCompat(srcDistrict, canon) {
  if (!srcDistrict || !canon.district) return "UNKNOWN";
  return nameKey(srcDistrict) === nameKey(canon.district) ? "SAME_DISTRICT" : "DISTRICT_CONFLICT";
}
function trustworthy(S, rec) {
  const c = S.cfg;
  if (c.taxonomy_field) return { ok: (c.allowed_taxonomy_values ?? []).includes(rec.props[c.taxonomy_field]), basis: `row-level taxonomy ${c.taxonomy_field}` };
  const nonGreen = (rcfg.name_based_non_green_tokens ?? []).find(t => clean(rec.name).toLocaleLowerCase("tr").includes(t));
  if (nonGreen) return { ok: false, basis: `name-only park evidence rejected: contains non-green token '${nonGreen}'` };
  if (c.taxonomy_rule === "name_contains_park_word") return { ok: parkWord(rec.name), basis: "row-level name contains park word" };
  return { ok: parkWord(rec.name), basis: "name contains park word (no taxonomy column)" };
}

const evidence = new Map();
for (const r of backlog.records) {
  const S = sources[r.source_code], srec = S.byId.get(String(r.external_id));
  if (!srec) throw new Error(`review record not found in raw source: ${reviewKey(r)}`);
  const cl = clusters[r.source_code];
  const cands = [];
  for (const n of nearbyCanonical(srec.latitude, srec.longitude, 700)) {
    if (n.city !== r.province || (n.source_refs ?? []).some(x => x.source_code === r.source_code && String(x.external_id) === String(r.external_id))) continue;
    const pd = distanceMeters(srec, n);
    if (pd > 700) continue;
    const npoly = osmPoly.get(n.id);
    let eff = pd, relation = "POINT_DISTANCE";
    if (srec.polys.length && npoly) { eff = polysGap(srec.polys, [...npoly]); }
    else if (srec.polys.length) { eff = pointPolysDist(n.longitude, n.latitude, srec.polys); }
    else if (npoly) { eff = pointPolysDist(srec.longitude, srec.latitude, npoly); }
    if (srec.polys.length || npoly) relation = eff === 0 ? "OVERLAP" : eff <= T.adjacent_m ? "ADJACENT" : "GAP";
    if (eff > T.extended_m) continue;
    const nm = NR(r.name, n.name);
    const dist = districtCompat(r.district, n);
    const strong = hasNameEvidence(nm);
    const plausible = dist !== "DISTRICT_CONFLICT" && (relation === "OVERLAP" || relation === "ADJACENT" || eff <= S.tier2 || (strong && eff <= T.extended_m));
    cands.push({ canonical_id: n.id, osm_id: n.osm_id, name: n.name, canonical_district: n.district || null, point_distance_m: Math.round(pd * 10) / 10, effective_distance_m: Math.round(eff * 10) / 10, relation, name: n.name, name_relationship: nm, district: dist, plausible, canonical_has_polygon: !!npoly, canonical_source_refs: (n.source_refs ?? []).map(x => x.source_code) });
  }
  cands.sort((a, b) => a.effective_distance_m - b.effective_distance_m);
  const plausible = cands.filter(c => c.plausible);
  const nf = nameFlags(r.name), tw = trustworthy(S, srec);
  const nearest = cands[0]?.effective_distance_m ?? null;
  const cid = cl.of.get(srec.key), cinfo = cl.info.get(cid);
  const flags = {
    EXACT_NORMALIZED_NAME: cands.some(c => c.name_relationship.exact_normalized_name),
    DISTINCTIVE_CORE_NAME_MATCH: cands.some(c => c.name_relationship.distinctive_core_name_match),
    HIGH_NAME_SIMILARITY: cands.some(c => c.name_relationship.high_name_similarity),
    GENERIC_NAME: nf.generic, PLACEHOLDER_NAME: nf.placeholder,
    SAME_PROVINCE: true,
    SAME_DISTRICT: cands.some(c => c.district === "SAME_DISTRICT"),
    DISTRICT_CONFLICT: cands.some(c => c.district === "DISTRICT_CONFLICT"),
    NEAREST_CANONICAL_DISTANCE_M: nearest,
    VERY_CLOSE: nearest !== null && nearest <= T.very_close_m,
    PRIMARY_RADIUS: nearest !== null && nearest <= S.tier2,
    EXTENDED_RADIUS: nearest !== null && nearest > S.tier2 && nearest <= T.extended_m,
    SINGLE_PLAUSIBLE_CANONICAL: plausible.length === 1,
    MULTIPLE_PLAUSIBLE_CANONICAL: plausible.length > 1,
    GEOMETRY_OVERLAP: cands.some(c => c.relation === "OVERLAP"),
    GEOMETRY_ADJACENT: cands.some(c => c.relation === "ADJACENT"),
    SOURCE_FRAGMENTATION_EVIDENCE: S.polygonSource && cinfo.size >= 2,
    WITHIN_SOURCE_DUPLICATE_EVIDENCE: cinfo.size >= 2,
    CROSS_SOURCE_DUPLICATE_EVIDENCE: cands.some(c => hasNameEvidence(c.name_relationship) && c.district !== "DISTRICT_CONFLICT"),
    STABLE_SOURCE_IDENTITY: true,
    TRUSTWORTHY_PARK_EVIDENCE: tw.ok
  };
  // physical-park taxonomy gate (physical-park-taxonomy-gate.mjs), present only when the cluster override carries it
  const taxonomy_class = clusterOverride?.source_code === r.source_code ? clusterOverride.records[String(r.external_id)]?.taxonomy_class ?? null : null;
  evidence.set(reviewKey(r), { flags, taxonomy_class, park_evidence_basis: tw.basis, candidates: cands, plausible_count: plausible.length, cluster: { id: cid, size: cinfo.size, class: cinfo.class, member_ids: cinfo.members, ambiguous_neighbors: cl.amb.get(srec.key) }, source_geometry: srec.polys.length ? "Polygon" : "Point", raw_props: Object.fromEntries((rcfg.sources[r.source_code]?.evidence_text_fields ?? []).map(f => [f, srec.props[f] ?? null])) });
}

/* ---------------- decisions ---------------- */
const hasSpatial = c => c.relation === "OVERLAP" || c.relation === "ADJACENT";
function recordTarget(r, E, S) {
  const myCluster = clusters[r.source_code].of.get(`${r.source_code}:${r.external_id}`);
  const sameCluster = o => clusters[r.source_code].of.get(o.key) === myCluster && clusters[r.source_code].info.get(myCluster).size >= 2;
  const P = E.candidates.filter(c => c.plausible);
  const strong = P.filter(c => hasNameEvidence(c.name_relationship));
  const generic = E.flags.GENERIC_NAME || E.flags.PLACEHOLDER_NAME;
  if (strong.length === 1) {
    const c = strong[0], kind = c.name_relationship.kind;
    const full = kind === "exact_normalized_name" || kind === "core_equal";
    const okDist = full ? c.effective_distance_m <= Math.max(S.tier2, T.extended_m) : c.effective_distance_m <= T.partial_name_max_m;
    if (c.canonical_source_refs.includes(r.source_code)) return { target: null, why: `the only name-evidence canonical is itself a record of the same source (${c.effective_distance_m} m away): within-source namesake, not a canonical match` };
    if (okDist) return { target: c, mode: "NAME_DRIVEN", why: `unique canonical with ${kind} name evidence at ${c.effective_distance_m} m (${c.relation})` };
    return { target: null, why: `only name-evidence canonical is beyond the distance allowed for ${kind}` };
  }
  if (strong.length > 1) return { target: null, why: `${strong.length} canonical parks share name evidence` };
  if (generic) {
    // spatial-only: generic/placeholder source name -> stricter evidence
    const O = P.filter(c => c.relation === "OVERLAP");
    let pick = null;
    if (O.length === 1) pick = O[0];
    else if (O.length === 0) { const A = P.filter(c => c.effective_distance_m <= T.very_close_m); if (A.length === 1 && P.length === 1) pick = A[0]; }
    if (!pick) return { target: null, why: "generic/placeholder name: no single overlapping or very-close canonical" };
    if (E.cluster.ambiguous_neighbors.length) return { target: null, why: "generic/placeholder name with an ambiguous within-source neighbour" };
    // shared target: other source records competing for the same canonical park
    const n = canonById.get(pick.canonical_id);
    const rivalsOverlap = S.recs.filter(o => o.key !== `${r.source_code}:${r.external_id}` && !sameCluster(o) && (pick.canonical_has_polygon ? pointPolysDist(o.longitude, o.latitude, osmPoly.get(pick.canonical_id)) === 0 : distanceMeters(o, n) <= T.very_close_m)).length;
    if (rivalsOverlap > 0) return { target: null, why: `generic name and ${rivalsOverlap} other source record(s) also fall on the same canonical park (sub-feature ambiguity)` };
    return { target: pick, mode: "SPATIAL_DRIVEN", why: `generic/placeholder name; single ${pick.relation === "OVERLAP" ? "overlapping" : "very-close"} canonical at ${pick.effective_distance_m} m, no competing source record` };
  }
  // specific name sharing a distinctive token with exactly one overlapping / very-close
  // canonical (single-token containment is not enough alone, spatial evidence completes it)
  if (!generic) {
    const part = P.filter(c => c.name_relationship.shares_distinctive_token && !c.name_relationship.numeric_conflict && (c.relation === "OVERLAP" || c.effective_distance_m <= T.very_close_m) && !c.canonical_source_refs.includes(r.source_code));
    const closeAll = P.filter(c => c.relation === "OVERLAP" || c.effective_distance_m <= T.very_close_m);
    if (part.length === 1 && closeAll.length === 1 && !E.cluster.ambiguous_neighbors.length)
      return { target: part[0], mode: "NAME_PARTIAL_SPATIAL", why: `shares a distinctive name token with the single ${part[0].relation === "OVERLAP" ? "overlapping" : "very-close"} canonical '${part[0].name}' at ${part[0].effective_distance_m} m` };
  }
  // specific source name, no name evidence: the name-upgrade pattern. Allowed only when
  // exactly one canonical park overlaps / is very close, it is generic-named, and no other
  // source record competes for it.
  const near = P.filter(c => c.relation === "OVERLAP" || c.effective_distance_m <= T.very_close_m);
  if (near.length === 1 && nameFlags(near[0].name).generic && !E.cluster.ambiguous_neighbors.length) {
    const pick = near[0], n = canonById.get(pick.canonical_id), me = `${r.source_code}:${r.external_id}`;
    const rivals = S.recs.filter(o => o.key !== me && !sameCluster(o) && (pick.canonical_has_polygon ? pointPolysDist(o.longitude, o.latitude, osmPoly.get(pick.canonical_id)) === 0 : distanceMeters(o, n) <= T.very_close_m)).length;
    if (!rivals) return { target: pick, mode: "NAME_UPGRADE_SPATIAL", why: `specific source name; single ${pick.relation === "OVERLAP" ? "overlapping" : "very-close"} generic-named canonical at ${pick.effective_distance_m} m (name-upgrade pattern), no competing source record` };
  }
  return { target: null, why: "specific name without name evidence for any nearby canonical" };
}
function newSafe(r, E, S) {
  const f = E.flags;
  const why = [];
  if (!f.TRUSTWORTHY_PARK_EVIDENCE) why.push("no trustworthy PARK evidence");
  if (E.taxonomy_class && E.taxonomy_class !== "PARK_CONFIRMED" && E.taxonomy_class !== "PARK_LIKELY") why.push(`physical-park taxonomy gate: ${E.taxonomy_class}`);
  if (f.GENERIC_NAME || f.PLACEHOLDER_NAME) why.push("generic/placeholder name never NEW from review");
  if (f.CROSS_SOURCE_DUPLICATE_EVIDENCE) why.push("canonical park with name evidence nearby");
  if (f.GEOMETRY_OVERLAP || f.GEOMETRY_ADJACENT) why.push("geometry overlaps/adjoins a canonical park");
  if (f.VERY_CLOSE) why.push("canonical park within very-close distance");
  if (E.candidates.some(c => c.plausible && c.name_relationship.numeric_conflict)) why.push("numeric-suffix variant of a nearby canonical name");
  if (E.cluster.ambiguous_neighbors.length) why.push(`ambiguous within-source neighbour (${E.cluster.ambiguous_neighbors[0].why})`);
  const shared = E.candidates.filter(c => c.plausible && c.name_relationship.shares_distinctive_token);
  if (shared.length) why.push(`shares a distinctive name token with nearby canonical '${shared[0].name}'`);
  // an unnamed/generic canonical park within the primary radius, with no polygon evidence to
  // separate it, cannot be excluded as the same park (name-upgrade pattern)
  const unseparated = E.candidates.filter(c => c.plausible && c.relation === "POINT_DISTANCE" && nameFlags(c.name).generic && c.effective_distance_m <= S.tier2);
  if (unseparated.length) why.push(`generic-named canonical park within ${unseparated[0].effective_distance_m} m without polygon evidence separating it`);
  return { ok: why.length === 0, why };
}

const decisions = new Map();
const recTargets = new Map();
for (const r of backlog.records) { const S = sources[r.source_code]; recTargets.set(reviewKey(r), recordTarget(r, evidence.get(reviewKey(r)), S)); }

for (const r of backlog.records) {
  const key = reviewKey(r), S = sources[r.source_code], E = evidence.get(key), rt = recTargets.get(key), cl = clusters[r.source_code];
  const srec = S.byId.get(String(r.external_id));
  const out = { source_code: r.source_code, source_external_id: String(r.external_id), name: r.name, province: r.province, district: r.district || null, original_review_reason: r.review_reason, latitude: r.latitude, longitude: r.longitude };
  const done = (outcome, reason, extra = {}) => decisions.set(key, { ...out, proposed_outcome: outcome, decision_reason: reason, ...extra });

  // non-park (source-side evidence only). A strong-name match to an existing canonical park
  // does not need separate park evidence (the canonical record IS a park).
  const nameDrivenMatch = rt.target && rt.mode === "NAME_DRIVEN";
  // taxonomy gate: NON_PARK clusters are rejected; TAXONOMY_AMBIGUOUS clusters allow only a strong-name match
  // to an existing canonical park (whose own record is the park evidence), never NEW / spatial / cluster decisions.
  if (E.taxonomy_class === "NON_PARK" && !parkWord(r.name)) { done("REJECT_NON_PARK", "physical-park taxonomy gate: cluster classified NON_PARK (non-park keyword in source layer/name, no park word)", { taxonomy_class: E.taxonomy_class }); continue; }
  if (E.taxonomy_class === "TAXONOMY_AMBIGUOUS" && !nameDrivenMatch) { done("KEEP_REVIEW", "physical-park taxonomy gate: cluster classified TAXONOMY_AMBIGUOUS (no sufficient row-level park evidence)", { taxonomy_class: E.taxonomy_class }); continue; }
  if (!E.flags.TRUSTWORTHY_PARK_EVIDENCE && !nameDrivenMatch) {
    const texts = Object.entries(E.raw_props).filter(([, v]) => typeof v === "string" && NONPARK.test(v));
    if (texts.length && !parkWord(r.name)) { done("REJECT_NON_PARK", `source attribute ${texts[0][0]}='${String(texts[0][1]).slice(0, 60)}' indicates a non-park feature and the name has no park word`, { non_park_evidence: texts.map(([k, v]) => ({ field: k, value: v })) }); continue; }
    done("KEEP_REVIEW", "no trustworthy PARK evidence in the source record and no source-side non-park evidence"); continue;
  }
  const cid = cl.of.get(srec.key), cinfo = cl.info.get(cid);
  const mates = cinfo.members.filter(m => m !== String(r.external_id)).map(m => S.byId.get(m));
  if (cinfo.size >= 2) {
    if (cinfo.class === "AMBIGUOUS" && !(rt.target && rt.mode === "NAME_DRIVEN")) { done("KEEP_REVIEW", "within-source cluster is ambiguous (same-name records nearby but not adjacent, or overlapping records with different names)", { cluster: { class: cinfo.class, members: cinfo.members } }); continue; }
    const accepted = mates.filter(m => m.status === "accepted");
    const acceptedCanon = new Set(accepted.map(m => m.canonical_id));
    const reviewMates = mates.filter(m => m.status === "review");
    if (acceptedCanon.size > 1) { done("KEEP_REVIEW", "cluster mates already map to different canonical parks"); continue; }
    if (acceptedCanon.size === 1) {
      const c = [...acceptedCanon][0];
      if (rt.target && rt.target.canonical_id !== c) { done("KEEP_REVIEW", "own canonical target conflicts with the canonical park of an already-accepted cluster mate"); continue; }
      done("REJECT_DUPLICATE", `duplicate/fragment of already-accepted source record ${accepted[0].id} (same physical park; ${E.flags.SOURCE_FRAGMENTATION_EVIDENCE ? "polygon fragment" : "duplicate record"})`, { duplicate_of_source_external_id: accepted[0].id, provenance_attach_to_canonical_id: c, cluster: { class: cinfo.class, members: cinfo.members } }); continue;
    }
    // no accepted mate: representative logic over review members
    const memberTargets = [r, ...reviewMates.map(m => ({ source_code: r.source_code, external_id: m.id }))].map(m => recTargets.get(reviewKey(m)));
    const tset = new Set(memberTargets.map(t => t?.target?.canonical_id ?? null));
    const ids = cinfo.members.map(Number).sort((a, b) => a - b).map(String);
    const rep = ids[0];
    const isRep = String(r.external_id) === rep;
    if (rt.target && tset.size === 1) {
      if (isRep) done("MATCH_EXISTING", rt.target.mode === "NAME_DRIVEN" ? `cluster representative; ${rt.why}` : `cluster representative; ${rt.why}`, { target_canonical_id: rt.target.canonical_id, cluster: { class: cinfo.class, members: cinfo.members } });
      else done("REJECT_DUPLICATE", `redundant member of a one-physical-park cluster whose representative (${rep}) matches canonical ${rt.target.canonical_id}`, { duplicate_of_source_external_id: rep, provenance_attach_to_canonical_id: rt.target.canonical_id, cluster: { class: cinfo.class, members: cinfo.members } });
      continue;
    }
    if (tset.size === 1 && tset.has(null)) {
      const okAll = [r, ...reviewMates.map(m => ({ source_code: r.source_code, external_id: m.id }))].every(m => newSafe(m, evidence.get(reviewKey(m)), S).ok || (evidence.get(reviewKey(m)).flags.CROSS_SOURCE_DUPLICATE_EVIDENCE === false && false));
      if (okAll || [r, ...reviewMates.map(m => ({ source_code: r.source_code, external_id: m.id }))].every(m => { const ns = newSafe(m, evidence.get(reviewKey(m)), S); return ns.ok; })) {
        if (isRep) done("NEW_CANONICAL_SAFE", "representative of a within-source duplicate/fragment cluster with no canonical match; all members satisfy the NEW safety conditions", { cluster: { class: cinfo.class, members: cinfo.members } });
        else done("REJECT_DUPLICATE", `redundant member of a within-source cluster represented by ${rep}`, { duplicate_of_source_external_id: rep, provenance_attach_to_new_source_external_id: rep, cluster: { class: cinfo.class, members: cinfo.members } });
        continue;
      }
    }
    done("KEEP_REVIEW", "within-source cluster members disagree on target or are not all safe to create", { cluster: { class: cinfo.class, members: cinfo.members } }); continue;
  }
  // singleton
  if (rt.target) { done("MATCH_EXISTING", rt.why, { target_canonical_id: rt.target.canonical_id, match_mode: rt.mode, target_distance_m: rt.target.effective_distance_m, target_relation: rt.target.relation, name_evidence: rt.target.name_relationship }); continue; }
  const ns = newSafe(r, E, S);
  if (ns.ok) { done("NEW_CANONICAL_SAFE", "trustworthy park evidence, specific name, no canonical park with name evidence nearby and no geometric overlap/adjacency; nearby canonical parks carry distinct specific names"); continue; }
  done("KEEP_REVIEW", `${rt.why}; not safe as new: ${ns.why.join("; ")}`);
}

/* ---------------- write artifacts ---------------- */
const rows = backlog.records.map(r => ({ ...decisions.get(reviewKey(r)), evidence: evidence.get(reviewKey(r)) }));
if (rows.length !== 615 || new Set(rows.map(x => `${x.source_code}:${x.source_external_id}`)).size !== 615) throw new Error("resolution does not cover exactly the 615 review records once each");
const count = (arr, f) => arr.reduce((o, x) => { const k = f(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});
const inv = {
  generated_at: new Date().toISOString(), total: rows.length,
  by_source: count(rows, x => x.source_code), by_reason: count(rows, x => x.original_review_reason),
  by_source_reason: count(rows, x => `${x.source_code}|${x.original_review_reason}`),
  by_geometry: count(rows, x => `${x.source_code}|${x.evidence.source_geometry}`),
  by_district_present: count(rows, x => `${x.source_code}|${x.district ? "district" : "no_district"}`),
  by_nearest_distance_band: count(rows, x => { const d = x.evidence.flags.NEAREST_CANONICAL_DISTANCE_M; return d === null ? "none" : d <= 30 ? "<=30" : d <= 100 ? "30-100" : d <= 150 ? "100-150" : d <= 250 ? "150-250" : ">250"; }),
  by_plausible_count: count(rows, x => String(x.evidence.plausible_count)),
  by_name_class: count(rows, x => x.evidence.flags.PLACEHOLDER_NAME ? "placeholder" : x.evidence.flags.GENERIC_NAME ? "generic" : "specific"),
  by_name_evidence: count(rows, x => x.evidence.flags.EXACT_NORMALIZED_NAME ? "exact" : x.evidence.flags.DISTINCTIVE_CORE_NAME_MATCH ? "core" : x.evidence.flags.HIGH_NAME_SIMILARITY ? "high_similarity" : "none")
};
const summary = { by_outcome: count(rows, x => x.proposed_outcome), by_source_outcome: count(rows, x => `${x.source_code}|${x.proposed_outcome}`), by_reason_outcome: count(rows, x => `${x.original_review_reason}|${x.proposed_outcome}`) };
await writeFile(new URL("inventory.json", outDir), JSON.stringify(inv, null, 1));
await writeFile(new URL("fragmentation.json", outDir), JSON.stringify(fragmentation, null, 1));
await writeFile(new URL("resolution.json", outDir), JSON.stringify({ generated_at: new Date().toISOString(), baseline_canonical: canonical.parks.length, total_reviews: rows.length, thresholds: T, summary, records: rows }, null, 1));
console.log(JSON.stringify({ inventory: { by_reason: inv.by_reason, by_nearest_distance_band: inv.by_nearest_distance_band, by_plausible_count: inv.by_plausible_count, by_name_class: inv.by_name_class, by_name_evidence: inv.by_name_evidence }, summary: summary.by_outcome, by_source_outcome: summary.by_source_outcome }, null, 1));
console.log("fragmentation", JSON.stringify(Object.fromEntries(Object.entries(fragmentation).map(([k, v]) => [k, { candidates: v.candidates, clusters_ge2: v.clusters_size_ge2, ONE: v.ONE_PHYSICAL_PARK_FRAGMENTED, AMB: v.AMBIGUOUS, in_clusters: v.records_in_clusters, name_groups: v.same_name_group_class, accepted_fragments: v.accepted_distinct_canonical_in_multi_record_clusters }]))));

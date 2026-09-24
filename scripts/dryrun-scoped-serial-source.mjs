import { readFile, writeFile, mkdir } from "node:fs/promises";
import { representativePoint } from "./polygon-geometry.mjs";
import {
  SERIAL_SCOPES, encodeScopedSerialId, isPlaceholderName, validateCompanionJoin, compareSnapshots,
  crossResourceNearDuplicates, packageScopeProof, validateScopedSerialResource, comparisonForResource
} from "./scoped-serial-identity.mjs";

// Generic DRY-RUN of the source-scoped serial identity policy for one source in
// data/scoped-serial-sources.json. Never touches the canonical preview / DB.
//   node scripts/dryrun-scoped-serial-source.mjs <source_code>
//        [--geo-dir=geo] [--ckan-state=manisa-ckan-meta.json]
//        [--previous-snapshot=<path>] [--snapshot-out=<path>] [--report-out=<path>]
// Paths are relative to <cache_dir> unless absolute.

const args = process.argv.slice(2);
const sourceCode = args.find(a => !a.startsWith("--"));
const flag = (n, d = null) => (args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)) ?? d;
if (!sourceCode) throw new Error("Usage: node scripts/dryrun-scoped-serial-source.mjs <source_code> [flags]");

const cfgFile = JSON.parse(await readFile(new URL("../data/scoped-serial-sources.json", import.meta.url), "utf8"));
const source = cfgFile.sources.find(s => s.source_code === sourceCode);
if (!source) throw new Error(`unknown scoped-serial source ${sourceCode}`);
const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const dir = new URL(`${source.cache_dir}/`, cacheRoot);
const at = p => (p.startsWith("/") ? p : new URL(p, dir).pathname);
const geoDir = flag("geo-dir", "geo");
const T = source.thresholds;

async function readJson(p) { return JSON.parse(await readFile(at(p), "utf8")); }

/* ---- CKAN upstream state (for check H) ---- */
function ckanState(list) {
  const out = {};
  for (const o of list) {
    const [pkg] = o.url_ids;
    const resources = o.mns_pkg?.result?.resources ?? [];
    out[pkg] = Object.fromEntries(resources.map(r => [r.id, { last_modified: r.last_modified ?? null, created: r.created ?? null, format: r.format }]));
  }
  return out;
}
const currentCkan = ckanState(await readJson(flag("ckan-state", "manisa-ckan-meta.json")));
const previous = flag("previous-snapshot") ? await readJson(flag("previous-snapshot")) : null;

/* ---- companion serial lists ---- */
function csvRows(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function companionSerials(c) {
  if (!c) return null;
  const text = await readFile(at(c.path), "utf8");
  if (c.type === "csv_column") return csvRows(text).map(r => (r[c.column] ?? "").trim()).filter(v => /^\d+$/.test(v));
  if (c.type === "text_regex") return [...text.replace(/,/g, ".").matchAll(new RegExp(c.regex, c.flags ?? "g"))].map(m => m[1]);
  throw new Error(`unknown companion type ${c.type}`);
}

/* ---- load records per resource ---- */
function repPoint(g) {
  if (!g) return null;
  if (g.type === "Point") return { latitude: g.coordinates[1], longitude: g.coordinates[0] };
  try {
    if (g.type === "Polygon") { const p = representativePoint([g.coordinates]); return { latitude: p.lat, longitude: p.lon }; }
    if (g.type === "MultiPolygon") { const p = representativePoint(g.coordinates); return { latitude: p.lat, longitude: p.lon }; }
  } catch { /* fall through */ }
  return null;
}
const perResource = [];
for (const r of source.resources) {
  const gj = await readJson(`${geoDir}/${r.geo_file}`);
  const rule = r.serial_rule;
  const recs = gj.features.map((f, index) => {
    const name = String(f.properties?.Name ?? f.properties?.name ?? "").trim();
    let serial = null;
    if (rule.type === "name_regex") { const m = name.match(new RegExp(rule.regex, rule.flags ?? "")); serial = m ? m[1] : null; }
    const p = repPoint(f.geometry);
    return { index, name, serial, geometry_type: f.geometry?.type ?? null, latitude: p?.latitude ?? null, longitude: p?.longitude ?? null,
      polygon: f.geometry?.type === "Polygon" ? f.geometry.coordinates : null, placeholder_name: isPlaceholderName(name) };
  });
  perResource.push({ cfg: r, recs });
}

/* ---- snapshot (current) ---- */
const snapshot = { source_code: sourceCode, taken_at: new Date().toISOString(), geo_dir: geoDir, resources: {}, ckan: currentCkan };
for (const { cfg, recs } of perResource) {
  if (cfg.serial_rule.type === "none") continue;
  snapshot.resources[cfg.package_uuid] ??= {};
  snapshot.resources[cfg.package_uuid][cfg.resource_uuid] = { serials: Object.fromEntries(recs.filter(x => x.serial !== null).map(x => [x.serial, { name: x.name, latitude: x.latitude, longitude: x.longitude }])) };
}
const comparison = previous ? compareSnapshots(previous, snapshot, source.snapshot_options ?? {}) : null;

/* ---- validate each resource ---- */
const results = [];
for (const { cfg, recs } of perResource) {
  const withSerial = recs.filter(x => x.serial !== null);
  const joinInfo = cfg.companion ? validateCompanionJoin(withSerial.map(x => x.serial), await companionSerials(cfg.companion), { min_join_coverage: T.min_join_coverage }) : null;
  let resourceState = null;
  if (previous?.ckan) {
    const prevRes = previous.ckan[cfg.package_uuid] ?? {};
    const curRes = currentCkan[cfg.package_uuid] ?? {};
    const gone = Object.keys(prevRes).filter(id => !(id in curRes));
    const added = Object.keys(curRes).filter(id => !(id in prevRes));
    resourceState = { replaced: gone.includes(cfg.resource_uuid), package_resources_gone: gone, package_resources_added: added,
      last_modified_changed: (prevRes[cfg.resource_uuid]?.last_modified ?? null) !== (curRes[cfg.resource_uuid]?.last_modified ?? null) };
  }
  const resComparison = comparisonForResource(comparison, cfg.resource_uuid, source.snapshot_options ?? {});
  const usable = cfg.serial_rule.type !== "none";
  const v = usable
    ? validateScopedSerialResource({ package_uuid: cfg.package_uuid, resource_uuid: cfg.resource_uuid, records: recs, serial_scope: source.serial_scope,
        companion_join: joinInfo, snapshot_comparison: resComparison, resource_state: resourceState, license_status: source.license.status },
        { min_serial_coverage: T.min_serial_coverage, min_join_coverage: T.min_join_coverage })
    : { status: "BLOCKED_IDENTITY", identity_valid: false, checks: [], failed: ["A"], note: cfg.serial_rule.reason };
  const relaxed = usable ? validateScopedSerialResource({ package_uuid: cfg.package_uuid, resource_uuid: cfg.resource_uuid, records: recs, serial_scope: source.serial_scope,
        companion_join: joinInfo, snapshot_comparison: resComparison, resource_state: resourceState, license_status: source.license.status },
        { min_serial_coverage: 0.9, min_join_coverage: T.min_join_coverage }).identity_valid : false;
  results.push({ key: cfg.key, title: cfg.title, package_uuid: cfg.package_uuid, resource_uuid: cfg.resource_uuid, features: recs.length,
    with_serial: withSerial.length, placeholder_names: recs.filter(x => x.placeholder_name).length, serial_rule: cfg.serial_rule.type,
    companion_join: joinInfo && { ...joinInfo, missing_serials: joinInfo.missing_serials.length, orphan_table_rows: joinInfo.orphan_table_rows.length },
    status: v.status, identity_valid: v.identity_valid, failed_checks: v.failed, identity_valid_at_0_9_serial_coverage: relaxed,
    example_external_id: withSerial[0] ? encodeScopedSerialId({ package_uuid: cfg.package_uuid, resource_uuid: cfg.resource_uuid, serial: withSerial[0].serial }) : null });
}

/* ---- package-scope proof (per package that has serial resources) ---- */
const byPkg = new Map();
for (const { cfg, recs } of perResource) {
  if (cfg.serial_rule.type === "none") continue;
  if (!byPkg.has(cfg.package_uuid)) byPkg.set(cfg.package_uuid, { upstream: cfg.upstream_geo_resource_uuids, loaded: {} });
  byPkg.get(cfg.package_uuid).loaded[cfg.resource_uuid] = recs.filter(x => x.serial !== null).map(x => x.serial);
}
const packageScope = [...byPkg.entries()].map(([pkg, { upstream, loaded }]) => ({ package_uuid: pkg, upstream_geo_resources: upstream.length, ...packageScopeProof({ upstream_geo_resource_uuids: upstream, loaded }) }));

/* ---- cross-resource duplicate guard over ALL records (identity or not) ---- */
const allRecs = perResource.flatMap(({ cfg, recs }) => recs.filter(x => x.latitude !== null).map(x => ({ key: `${cfg.key}#${x.index}:${x.name}`, resource_uuid: cfg.resource_uuid, name: x.name, latitude: x.latitude, longitude: x.longitude, polygon: x.polygon })));
const dupPairs = crossResourceNearDuplicates(allRecs, { close_m: T.close_m, strong_name_m: T.strong_name_m });

/* ---- aggregate ---- */
const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
const usableRes = results.filter(r => r.serial_rule !== "none");
const idValid = results.filter(r => r.identity_valid);
const report = {
  source_code: sourceCode, generated_at: new Date().toISOString(), geo_dir: geoDir, license: source.license, serial_scope_default: source.serial_scope,
  totals: {
    resources_inspected: results.length, features_inspected: sum(results, r => r.features),
    resources_with_usable_serial_rule: usableRes.length, features_with_serial: sum(results, r => r.with_serial),
    features_without_serial: sum(results, r => r.features - r.with_serial),
    resource_scope_identity_valid: idValid.length, features_covered_by_identity_valid_resources: sum(idValid, r => r.features),
    features_with_serial_in_blocked_resources: sum(results.filter(r => !r.identity_valid), r => r.with_serial),
    resources_valid_if_serial_coverage_0_9: results.filter(r => r.identity_valid_at_0_9_serial_coverage).length,
    package_scope_proven_packages: packageScope.filter(p => p.proven).length, package_scope_candidate_packages: packageScope.length,
    placeholder_names_all: sum(results, r => r.placeholder_names),
    placeholder_names_in_identity_valid: sum(idValid, r => r.placeholder_names),
    duplicate_scoped_identities: sum(results, r => (r.failed_checks.includes("B") || r.failed_checks.includes("G") ? 1 : 0)),
    cross_resource_duplicate_candidates: dupPairs.length,
    status_counts: results.reduce((a, r) => (a[r.status] = (a[r.status] ?? 0) + 1, a), {}),
    canonical_onboarding_allowed: results.some(r => r.status === "READY_FOR_RECONCILIATION")
  },
  companion_join: (() => { const j = results.filter(r => r.companion_join); const f = sum(j, r => r.companion_join.feature_count), k = sum(j, r => r.companion_join.joined_count);
    return { resources_with_companion: j.length, features: f, joined: k, coverage: f ? Math.round((k / f) * 10000) / 10000 : null,
      missing: sum(j, r => r.companion_join.missing_serials), orphan_table_rows: sum(j, r => r.companion_join.orphan_table_rows), resources_below_threshold: j.filter(r => !r.companion_join.passes).map(r => r.key) }; })(),
  snapshot_stability: comparison ? { blocked: comparison.blocked, blockers: comparison.blockers, counts: comparison.counts, flags: comparison.flags } : { note: "no previous snapshot supplied (first ingest)" },
  package_scope: packageScope, cross_resource_duplicates: dupPairs, resources: results
};
const snapOut = flag("snapshot-out"); const repOut = flag("report-out");
if (snapOut) { await mkdir(new URL("./", `file://${at(snapOut)}`).pathname, { recursive: true }); await writeFile(at(snapOut), JSON.stringify(snapshot)); }
if (repOut) { await mkdir(new URL("./", `file://${at(repOut)}`).pathname, { recursive: true }); await writeFile(at(repOut), JSON.stringify(report, null, 1)); }
console.log(JSON.stringify({ totals: report.totals, companion_join: report.companion_join, snapshot_stability: report.snapshot_stability.counts ?? report.snapshot_stability, package_scope_sample: packageScope.slice(0, 3) }, null, 1));

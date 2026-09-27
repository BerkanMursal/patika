import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBundle } from "./canonical-release-bundle.mjs";

// READ-ONLY inventory of a target database (intended: production) against a frozen
// canonical release bundle. It never writes, migrates or imports:
//   * every statement runs inside ONE `BEGIN TRANSACTION READ ONLY` that always ends in
//     ROLLBACK, after `SET default_transaction_read_only = on` (the server rejects any write,
//     including CREATE TEMP TABLE, even if a query here were wrong)
//   * the SQL text is statically checked for write/DDL keywords before it is sent
//   * the target must be given explicitly; local targets are refused without --allow-local
//   * credentials are never printed: pass them via the psql command's own mechanisms
//     (PGPASSWORD / ~/.pgpass / service file), not on this script's command line
// RC ids are compared in JS (read-only transactions cannot create temp tables).
//
//   node scripts/inventory-production-readonly.mjs --psql="<psql command for the target>" \
//        [--release=patika-parks-2026-09-27-rc1] [--bundle=<dir>] [--out=<dir>] [--allow-local]
// Outputs (gitignored): <out>/inventory.json and <out>/proposed-environment-policy.json
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2), val = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null, flag = n => argv.includes(`--${n}`);
const psqlCmd = val("psql");
if (!psqlCmd) {
  console.error("PRODUCTION INVENTORY NOT RUN: --psql=<command> is required (see docs/CANONICAL_PARK_LIFECYCLE.md §12)");
  process.exit(2);
}
// local-target guard, part 1: obvious local hosts in the connection text. Part 2 (below,
// before any inventory query) asks the server where the connection actually landed, so a
// local psql binary used purely as a client for a remote host is fine.
const LOCAL = /127\.0\.0\.1|localhost|\[::1\]|host=\/|:54322\b/;
if (LOCAL.test(psqlCmd) && !flag("allow-local")) {
  console.error("refusing: the target looks local (use --allow-local only to test this tool against a local database)");
  process.exit(2);
}

/* ---------- read-only execution ---------- */
const FORBIDDEN = /\b(insert|update|delete|merge|upsert|truncate|create|alter|drop|grant|revoke|comment|vacuum|reindex|cluster|refresh|lock|call|copy\s+\w+\s+from|set\s+(?!local\s+statement_timeout|default_transaction_read_only))\b/i;
function assertReadOnlySql(sql) {
  const body = sql.replace(/--.*$/gm, "").replace(/'([^']|'')*'/g, "''");
  const m = body.match(FORBIDDEN);
  if (m) throw new Error(`refusing to send SQL containing a write/DDL keyword: '${m[0]}'`);
}
function runReadOnly(queries) {
  const sql = queries.join("\n");
  assertReadOnlySql(sql);
  const script = [
    "\\set ON_ERROR_STOP on",
    "set default_transaction_read_only = on;",
    "begin transaction read only;",
    "set local statement_timeout = '120s';",
    "select 'READONLY_GUARD:' || current_setting('transaction_read_only');",
    sql,
    "rollback;"
  ].join("\n") + "\n";
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", `${psqlCmd} -X -q -At -F '\t'`], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`psql exited ${code}: ${(err.match(/(ERROR|FATAL):.*$/m) ?? [err.trim().split("\n").pop() ?? ""])[0]}`));
      if (!/^READONLY_GUARD:on$/m.test(out)) return reject(new Error("read-only guard not confirmed by the server; aborting"));
      resolve(out.split("\n").filter(l => l && !l.startsWith("READONLY_GUARD:")));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(script);
  });
}
// each query returns ONE row: tag \t json
const tagged = rows => Object.fromEntries(rows.map(r => { const i = r.indexOf("\t"); return [r.slice(0, i), JSON.parse(r.slice(i + 1))]; }));

/* ---------- frozen bundle ---------- */
const releaseId = val("release") ?? "patika-parks-2026-09-27-rc1";
const cfg = JSON.parse(await readFile(path.join(root, "data/canonical-releases", `${releaseId}.json`), "utf8"));
const bundleDir = path.resolve(val("bundle") ?? path.join(root, "data/park-enrichment/.cache/releases", releaseId));
const { data, manifestSha256 } = await validateBundle(bundleDir, { expectedManifestSha256: cfg.expected_manifest_sha256, expectedCounts: cfg.expected_counts, releaseId });
const rcIds = new Set(data.parks.map(p => p.id));
const rcRefs = new Map(data.park_source_refs.map(r => [`${r.source_code}:${r.external_id}`, r.park_id]));
const rcRetired = new Map([...data.aliases.map(a => [a.retired_park_id, `alias -> ${a.canonical_park_id}`]), ...data.tombstones.map(t => [t.retired_park_id, `tombstone ${t.status}`])]);
const rcHeld = new Set([...data.tombstones.flatMap(t => t.source_refs), ...data.reviews, ...data.rejections].map(r => `${r.source_code}:${r.external_id}`));
const scope = new Set(data.park_source_refs.map(r => r.source_code));

/* ---------- preflight: where did the connection land? ---------- */
const where = tagged(await runReadOnly([
  `select 'where', jsonb_build_object('addr_class', case when inet_server_addr() is null then 'socket' when host(inet_server_addr()) in ('127.0.0.1','::1') then 'loopback' else 'remote' end);`
])).where;
if (where.addr_class !== "remote" && !flag("allow-local")) {
  console.error(`refusing: the connection landed on a ${where.addr_class} server (local database); nothing was inventoried`);
  process.exit(2);
}

/* ---------- pass 1: identity, counts, schema state ---------- */
const exists = t => `to_regclass('public.${t}') is not null`;
const pass1 = tagged(await runReadOnly([
  `select 'target', jsonb_build_object('database', current_database(), 'server_version', current_setting('server_version'), 'server_addr_class', case when inet_server_addr() is null then 'socket' when host(inet_server_addr()) in ('127.0.0.1','::1') then 'loopback' else 'remote' end);`,
  `select 'counts', jsonb_build_object(
     'parks', (select count(*) from public.parks), 'parks_active', (select count(*) from public.parks where active), 'parks_inactive', (select count(*) from public.parks where not active),
     'park_source_refs', case when ${exists("park_source_refs")} then (select count(*) from public.park_source_refs) end,
     'feeding_points', (select count(*) from public.feeding_points), 'feeding_events', (select count(*) from public.feeding_events),
     'observations', (select count(*) from public.observations), 'favorites', (select count(*) from public.favorites),
     'park_name_suggestions_by_status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.park_name_suggestions group by status) s),
     'reports', (select count(*) from public.reports), 'reports_by_status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.reports group by status) s));`,
  `select 'schema', jsonb_build_object(
     'migrations', case when to_regclass('supabase_migrations.schema_migrations') is not null then (select jsonb_agg(version order by version) from supabase_migrations.schema_migrations) end,
     'lifecycle_migration_202609270001', case when to_regclass('supabase_migrations.schema_migrations') is not null then exists (select 1 from supabase_migrations.schema_migrations where version = '202609270001') end,
     'tables', jsonb_build_object(${["park_source_refs", "canonical_park_releases", "canonical_park_aliases", "canonical_park_tombstones", "canonical_park_tombstone_refs", "canonical_park_reviews", "canonical_park_rejections"].map(t => `'${t}', ${exists(t)}`).join(", ")}),
     'resolve_park_id', to_regprocedure('public.resolve_park_id(uuid)') is not null);`,
  `select 'parks', coalesce(jsonb_agg(jsonb_build_array(id, osm_id, active)), '[]') from public.parks;`,
  `select 'refs', case when ${exists("park_source_refs")} then (select coalesce(jsonb_agg(jsonb_build_array(source_code, external_id, park_id)), '[]') from public.park_source_refs) else '[]'::jsonb end;`
]));

const dbParks = pass1.parks.map(([id, osm_id, active]) => ({ id, osm_id, active }));
const dbRefs = pass1.refs.map(([source_code, external_id, park_id]) => ({ source_code, external_id, park_id }));
const dbIds = new Set(dbParks.map(p => p.id));
const dbOnly = dbParks.filter(p => !rcIds.has(p.id) && !rcRetired.has(p.id));
const retiredInDb = dbParks.filter(p => rcRetired.has(p.id));
const detailIds = [...dbOnly, ...retiredInDb].map(p => p.id);

/* ---------- pass 2: per-park detail for DB-only and to-be-retired parks ---------- */
let detail = [];
if (detailIds.length) {
  if (detailIds.some(id => !/^[0-9a-f-]{36}$/.test(id))) throw new Error("unexpected park id format");
  const ids = `array[${detailIds.map(id => `'${id}'`).join(",")}]::uuid[]`;
  const pass2 = tagged(await runReadOnly([`select 'detail', coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'city', p.city, 'osm_id', p.osm_id, 'active', p.active, 'source', p.source, 'imported_at', p.imported_at,
      'feeding_points', (select count(*) from public.feeding_points fp where fp.park_id = p.id),
      'feeding_events', (select count(*) from public.feeding_events e where e.park_id = p.id or e.point_id in (select id from public.feeding_points where park_id = p.id)),
      'observations', (select count(*) from public.observations o where o.point_id in (select id from public.feeding_points where park_id = p.id)),
      'favorites', (select count(*) from public.favorites f where f.park_id = p.id),
      'name_suggestions', (select count(*) from public.park_name_suggestions s where s.park_id = p.id),
      'reports', (select count(*) from public.reports r where r.park_id = p.id)) order by p.id), '[]')
    from public.parks p where p.id = any(${ids});`]));
  detail = pass2.detail;
}
const refsByPark = new Map();
for (const r of dbRefs) { if (!refsByPark.has(r.park_id)) refsByPark.set(r.park_id, []); refsByPark.get(r.park_id).push(`${r.source_code}:${r.external_id}`); }
const HISTORY = ["feeding_events", "observations", "favorites", "name_suggestions", "reports"];
const classified = detail.filter(d => !rcRetired.has(d.id)).map(d => {
  const refs = refsByPark.get(d.id) ?? [];
  const history = HISTORY.some(k => d[k] > 0);
  const provenance = !!d.osm_id || refs.length > 0;
  const sources = [...new Set([...refs.map(k => k.split(":")[0]), ...(d.osm_id ? ["osm"] : [])])];
  const refsInRelease = refs.filter(k => rcRefs.has(k) || rcHeld.has(k)).length;
  const withdrawnCandidate = provenance && refsInRelease === 0 && sources.every(s => scope.has(s));
  return {
    ...d, source_refs: refs, has_user_history: history,
    classification: history ? "DB_ONLY_WITH_USER_HISTORY" : "DB_ONLY_NO_USER_HISTORY",
    evidence: { has_provenance: provenance, provenance_sources: sources, refs_present_in_release: refsInRelease, source_withdrawn_candidate: withdrawnCandidate },
    // TEST_FIXTURE is never inferred: it needs explicit, human-recorded evidence.
    proposed_action: withdrawnCandidate ? "SOURCE_WITHDRAWN" : "MANUAL_REVIEW"
  };
});
const retiring = detail.filter(d => rcRetired.has(d.id)).map(d => ({ ...d, source_refs: refsByPark.get(d.id) ?? [], release_lifecycle: rcRetired.get(d.id), has_user_history: HISTORY.some(k => d[k] > 0) }));

/* ---------- RC vs target comparison ---------- */
const refConflicts = dbRefs.filter(r => rcRefs.has(`${r.source_code}:${r.external_id}`) && rcRefs.get(`${r.source_code}:${r.external_id}`) !== r.park_id && !rcRetired.has(r.park_id)).length;
const comparison = {
  target_parks: dbParks.length, rc_parks: rcIds.size,
  target_parks_in_rc: dbParks.filter(p => rcIds.has(p.id)).length,
  rc_parks_missing_from_target: [...rcIds].filter(id => !dbIds.has(id)).length,
  target_only_parks: dbOnly.length,
  target_parks_retired_by_rc: retiredInDb.length,
  target_rc_parks_inactive: dbParks.filter(p => rcIds.has(p.id) && !p.active).length,
  source_refs: {
    target: dbRefs.length, rc: rcRefs.size,
    target_refs_same_park_in_rc: dbRefs.filter(r => rcRefs.get(`${r.source_code}:${r.external_id}`) === r.park_id).length,
    target_refs_on_other_park_in_rc: refConflicts,
    target_refs_absent_from_rc_live: dbRefs.filter(r => !rcRefs.has(`${r.source_code}:${r.external_id}`)).length,
    rc_refs_missing_from_target: (() => { const have = new Set(dbRefs.map(r => `${r.source_code}:${r.external_id}`)); return [...rcRefs.keys()].filter(k => !have.has(k)).length; })()
  }
};

/* ---------- outputs ---------- */
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(val("out") ?? path.join(root, "data/park-enrichment/.cache/production-inventory", stamp));
await mkdir(outDir, { recursive: true });
const inventory = { generated_at: new Date().toISOString(), read_only: true, release_id: releaseId, bundle_manifest_sha256: manifestSha256,
  target: pass1.target, counts: pass1.counts, schema: pass1.schema, comparison, db_only_parks: classified, parks_retired_by_release: retiring };
const policy = {
  _note: "PROPOSAL generated by scripts/inventory-production-readonly.mjs from a READ-ONLY inventory. Not applied, not consumed automatically. Every DB-only park needs a human-confirmed action before any import: KEEP_ACTIVE | KEEP_INACTIVE | SOURCE_WITHDRAWN | TEST_FIXTURE | MANUAL_REVIEW. TEST_FIXTURE requires explicit recorded evidence; it is never proposed automatically.",
  environment: "production", release_id: releaseId, generated_at: inventory.generated_at, status: "PROPOSAL_NOT_APPLIED",
  fixtures: [], tombstone_user_content_ack: [],
  db_only_parks: classified.map(c => ({ park_id: c.id, name: c.name, classification: c.classification, proposed_action: c.proposed_action, evidence: { ...c.evidence, user_history: Object.fromEntries(HISTORY.map(k => [k, c[k]])) }, confirmed: false }))
};
await writeFile(path.join(outDir, "inventory.json"), JSON.stringify(inventory, null, 1));
await writeFile(path.join(outDir, "proposed-environment-policy.json"), JSON.stringify(policy, null, 1));
console.log(JSON.stringify({ result: "READ-ONLY INVENTORY COMPLETE (every transaction rolled back)", out: path.relative(root, outDir), target: pass1.target, counts: pass1.counts,
  lifecycle_schema: { migration_202609270001: pass1.schema.lifecycle_migration_202609270001, resolve_park_id: pass1.schema.resolve_park_id, tables: pass1.schema.tables },
  comparison, db_only: classified.map(c => ({ id: c.id, name: c.name, classification: c.classification, proposed_action: c.proposed_action })), parks_retired_by_release: retiring.length }, null, 1));

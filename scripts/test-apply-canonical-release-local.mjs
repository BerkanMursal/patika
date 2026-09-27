import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// LOCAL-ONLY end-to-end test of apply-canonical-release.mjs against the local Supabase
// Docker database (container supabase_db_patika). Never points anywhere else.
//  1. data-only baseline dump of every table the importer can touch + fingerprint
//  2. seed a SIMULATED LEGACY BASE: a few of the release's own retired/survivor parks with
//     user content, as if the previous canonical base had been imported (the real local DB
//     holds none of the 66 retired ids, so the alias/tombstone content paths need this)
//  3. negative tests (corrupt artifact, modified manifest, injected late failure, tombstone
//     with user history, unknown DB-only park) - each must leave the fingerprint unchanged
//  4. apply  5. re-apply (no-op) + forced re-apply (in-transaction guard) - fingerprint unchanged
//  6. user-content / resolver regression assertions  7. restore the baseline dump
//   node scripts/test-apply-canonical-release-local.mjs [--keep-applied]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "supabase_db_patika";
const PSQL = `docker exec -i ${CONTAINER} psql -U postgres -d postgres`;
const REL = "patika-parks-2026-09-27-rc1";
const bundle = path.join(root, "data/park-enrichment/.cache/releases", REL);
const work = path.join(root, "data/park-enrichment/.cache/releases/local-apply-test");
const ENV = path.join(root, "data/canonical-releases/environments/local.json");
const TABLES = ["parks", "park_source_refs", "feeding_points", "feeding_events", "observations", "favorites", "park_name_suggestions", "reports", "point_transactions",
  "canonical_park_releases", "canonical_park_aliases", "canonical_park_tombstones", "canonical_park_tombstone_refs", "canonical_park_reviews", "canonical_park_rejections"];
const results = [];
const check = (ok, label, detail) => { results.push({ ok: !!ok, label, ...(detail !== undefined ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); };

const sql = (q, user = "postgres") => {
  const r = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", user, "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: q, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
};
const json = q => JSON.parse(sql(q) || "null");
const importer = (...args) => spawnSync("node", [path.join(root, "scripts/apply-canonical-release.mjs"), `--psql=${PSQL}`, `--environment=${ENV}`, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
const fingerprint = () => JSON.parse(importer("--fingerprint").stdout);
const sameFp = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });

/* ---------- 1. baseline ---------- */
const dumpFile = "/tmp/patika-local-apply-baseline.sql";
execFileSync("docker", ["exec", CONTAINER, "pg_dump", "-U", "supabase_admin", "-d", "postgres", "--data-only", "--disable-triggers", ...TABLES.flatMap(t => ["-t", `public.${t}`]), "-f", dumpFile]);
const fp0 = fingerprint();
const restore = () => {
  sql(`begin; set local session_replication_role = replica; set local patika.lifecycle_maintenance = 'on';
    truncate ${TABLES.map(t => `public.${t}`).join(", ")}; commit;`, "supabase_admin");
  execFileSync("docker", ["exec", CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", dumpFile]);
};
let applied = null, after = null, fpSeeded = null, start = null;
try {
start = Object.fromEntries(Object.entries(fp0).map(([t, v]) => [t, v.rows]));
start.active_parks = Number(sql("select count(*) from parks where active"));
console.log("START", JSON.stringify(start));

/* ---------- 2. simulated legacy base (seed) ---------- */
const base = JSON.parse(await readFile(path.join(root, "data/park-enrichment/.cache/nationwide-canonical-preview.json"), "utf8"));
const baseById = new Map(base.parks.map(p => [p.id, p]));
const aliases = JSON.parse(await readFile(path.join(bundle, "aliases.json"), "utf8"));
const tombs = JSON.parse(await readFile(path.join(bundle, "tombstones.json"), "utf8"));
const liveIds = new Set(JSON.parse(await readFile(path.join(bundle, "parks.json"), "utf8")).map(p => p.id));
const muniPair = aliases.find(a => !baseById.get(a.canonical_park_id).osm_id);
const osmPair = aliases.find(a => baseById.get(a.canonical_park_id).osm_id);
const tombTax = tombs.find(t => t.status === "taxonomy_review" && !aliases.some(a => a.retired_park_id === t.retired_park_id));
const tombNon = tombs.find(t => t.status === "non_park");
const users = sql("select id from auth.users where email like '%@example.test' order by id limit 3").split("\n");
const [uA, uB, uC] = users;
const seedParks = [muniPair.retired_park_id, muniPair.canonical_park_id, osmPair.retired_park_id, osmPair.canonical_park_id, tombTax.retired_park_id, tombNon.retired_park_id];
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const parkRow = id => { const p = baseById.get(id); return `(${q(p.id)}, ${p.osm_id ? q(p.osm_id) : "null"}, ${q(p.name)}, ${q(p.city)}, ${q(p.district ?? "")}, ${p.latitude}, ${p.longitude}, true, ${q(p.osm_id ? "OpenStreetMap" : p.source)})`; };
const R = muniPair.retired_park_id, S = muniPair.canonical_park_id;
const seedSql = `begin;
insert into parks(id, osm_id, name, city, district, latitude, longitude, active, source) values ${seedParks.map(parkRow).join(",\n")};
insert into park_source_refs(source_code, external_id, park_id, source_url) values ${seedParks.flatMap(id => baseById.get(id).source_refs.map(r => `(${q(r.source_code)}, ${q(r.external_id)}, ${q(id)}, ${q(r.source_url ?? "")})`)).join(",\n")};
insert into feeding_points(id, park_id, name, latitude, longitude) select id, id, 'Park içi genel nokta', latitude, longitude from parks where id in (${seedParks.map(q).join(",")});
insert into feeding_points(id, park_id, name, latitude, longitude) select 'e1000000-0000-4000-8000-000000000001', id, 'Kuzey kapı noktası', latitude, longitude from parks where id = ${q(R)};
insert into feeding_events(id, user_id, point_id, park_id, food_type, food_grams, water_ml, photo_path, occurred_at) values
  ('e2000000-0000-4000-8000-000000000001', ${q(uA)}, ${q(R)}, ${q(R)}, 'dry', 200, 0, 'seed/e2-1.jpg', now() - interval '3 days'),
  ('e2000000-0000-4000-8000-000000000002', ${q(uB)}, 'e1000000-0000-4000-8000-000000000001', ${q(R)}, 'wet', 100, 500, 'seed/e2-2.jpg', now() - interval '2 days'),
  ('e2000000-0000-4000-8000-000000000003', ${q(uA)}, ${q(S)}, ${q(S)}, 'dry', 150, 0, 'seed/e2-3.jpg', now() - interval '1 day');
insert into observations(id, user_id, point_id, food_status, water_status) values
  ('e3000000-0000-4000-8000-000000000001', ${q(uA)}, ${q(R)}, 'low', 'empty'),
  ('e3000000-0000-4000-8000-000000000002', ${q(uC)}, 'e1000000-0000-4000-8000-000000000001', 'full', 'full');
insert into favorites(user_id, park_id, created_at) values (${q(uA)}, ${q(R)}, now() - interval '10 days'), (${q(uA)}, ${q(S)}, now() - interval '5 days'), (${q(uB)}, ${q(R)}, now() - interval '4 days');
insert into park_name_suggestions(id, park_id, user_id, original_name, proposed_name, evidence, status) values
  ('e4000000-0000-4000-8000-000000000001', ${q(R)}, ${q(uC)}, ${q(baseById.get(R).name)}, 'Önerilen Park Adı', 'Tabelada bu ad yazıyor, yerinde gördüm.', 'pending'),
  ('e4000000-0000-4000-8000-000000000002', ${q(R)}, ${q(uA)}, ${q(baseById.get(R).name)}, 'Başka Park Adı', 'Mahalle sakinleri bu adı kullanıyor.', 'pending'),
  ('e4000000-0000-4000-8000-000000000003', ${q(S)}, ${q(uA)}, ${q(baseById.get(S).name)}, 'Üçüncü Park Adı', 'Belediye levhasında bu ad var.', 'pending'),
  ('e4000000-0000-4000-8000-000000000004', ${q(R)}, ${q(uB)}, ${q(baseById.get(R).name)}, 'Eski Onaylı Ad', 'Geçmişte onaylanmış bir öneri kaydı.', 'rejected');
insert into reports(id, user_id, park_id, reason, detail, status) values
  ('e5000000-0000-4000-8000-000000000001', ${q(uB)}, ${q(R)}, 'Yanlış konum', 'Park konumu birkaç metre kaymış görünüyor.', 'open'),
  ('e5000000-0000-4000-8000-000000000002', ${q(uC)}, ${q(R)}, 'Kapalı alan', 'Bu alan geçen ay kapatılmıştı, kontrol edin.', 'resolved');
commit;`;
sql(seedSql);
fpSeeded = fingerprint();
console.log("SEEDED legacy base:", JSON.stringify({ muniPair: [R, S], osmPair: [osmPair.retired_park_id, osmPair.canonical_park_id], tombTax: tombTax.retired_park_id, tombNon: tombNon.retired_park_id }));

/* ---------- 3. negative tests ---------- */
// (a) corrupted artifact
await cp(bundle, path.join(work, "corrupt"), { recursive: true });
{ const f = path.join(work, "corrupt/parks.json"); const s = await readFile(f, "utf8"); await writeFile(f, s.replace("İsimsiz park", "İsimsiz parK")); }
let r = importer(`--bundle=${path.join(work, "corrupt")}`);
check(r.status !== 0 && /sha256 mismatch/.test(r.stderr), "corrupted artifact -> hard failure before any DB access", r.stderr.split("\n").find(l => /^Error: bundle validation/.test(l))?.trim());
// (b) modified manifest
await cp(bundle, path.join(work, "manifest"), { recursive: true });
{ const f = path.join(work, "manifest/manifest.json"); const m = JSON.parse(await readFile(f, "utf8")); m.expected_counts.parks = 26404; await writeFile(f, JSON.stringify(m, null, 2) + "\n"); }
r = importer(`--bundle=${path.join(work, "manifest")}`);
check(r.status !== 0 && /manifest sha256/.test(r.stderr), "modified manifest -> hard failure", r.stderr.split("\n").find(l => /^Error: bundle validation/.test(l))?.trim());
// (c) late injected failure (after every write, right before invariants)
r = importer("--inject-failure=before_invariants");
check(r.status !== 0 && /injected test failure/.test(r.stderr) && sameFp(fingerprint(), fpSeeded), "failure after all writes -> whole release rolled back (fingerprint unchanged)");
// (d) release tombstone of a park with user history, no acknowledgement
sql(`insert into favorites(user_id, park_id) values (${q(uC)}, ${q(tombTax.retired_park_id)})`);
r = importer();
check(r.status !== 0 && /tombstones parks with user history without acknowledgement/.test(r.stderr), "tombstoning a park with user history requires explicit ack");
sql(`delete from favorites where user_id = ${q(uC)} and park_id = ${q(tombTax.retired_park_id)}`);
// (e) unknown DB-only park (no provenance, not a listed fixture)
sql(`insert into parks(id, name, city, latitude, longitude, source) values ('e9000000-0000-4000-8000-000000000001', 'Elle Eklenmiş Park', 'İzmir', 38.40, 27.10, 'manual')`);
r = importer();
check(r.status !== 0 && /unclassifiable DB-only parks/.test(r.stderr), "unknown DB-only park -> abort (never guessed as fixture)");
sql(`delete from parks where id = 'e9000000-0000-4000-8000-000000000001'`);
check(sameFp(fingerprint(), fpSeeded), "after all negative tests the database is byte-identical to the seeded baseline");

/* ---------- 4. apply ---------- */
r = importer();
check(r.status === 0, "release applied in one transaction", r.status === 0 ? undefined : r.stderr);
applied = JSON.parse(r.stdout);
const fp1 = fingerprint();
await writeFile(path.join(work, "apply-report.json"), JSON.stringify(applied, null, 1));

/* ---------- 5. re-apply ---------- */
r = importer();
check(r.status === 0 && /NO-OP/.test(r.stdout) && sameFp(fingerprint(), fp1), "second run: NO-OP, zero changed rows (fingerprint identical)");
r = importer("--skip-precheck");
check(r.status !== 0 && /already recorded/.test(r.stderr) && sameFp(fingerprint(), fp1), "forced second run hits the in-transaction guard and rolls back, zero changed rows");

/* ---------- 6. regression ---------- */
const res = id => json(`select row_to_json(r) from resolve_park_id(${q(id)}) r`);
const W = sql("select id from parks where osm_id = 'way/600671941'");
check(res(W)?.status === "tombstone" && res(W)?.tombstone_status === "source_withdrawn", "DB-only OSM park way/600671941 resolves tombstone/source_withdrawn", res(W));
check(sql(`select active from parks where id = ${q(W)}`) === "f" && sql(`select count(*) from feeding_points where park_id = ${q(W)}`) === "1", "source_withdrawn parks row + its feeding point kept (inactive park), nothing deleted");
check(sql(`select count(*) from canonical_park_tombstone_refs where source_code = 'osm' and external_id = 'way/600671941'`) === "1" && sql(`select count(*) from park_source_refs where external_id = 'way/600671941'`) === "0", "withdrawn park's OSM ref moved to tombstone refs");
for (const f of ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002"]) check(res(f)?.status === "live", `fixture ${f} untouched (still live)`);
check(sql("select count(*) from feeding_events where id = 'd0000000-0000-4000-8000-000000000001' and park_id = 'a0000000-0000-4000-8000-000000000001'") === "1", "fixture's smoke feeding event untouched");
check(res(R)?.status === "alias" && res(R)?.resolved_park_id === S, "seeded retired park resolves alias -> survivor", res(R));
check(res(osmPair.retired_park_id)?.resolved_park_id === osmPair.canonical_park_id, "alias to an OSM survivor resolves");
const unseeded = aliases.find(a => !seedParks.includes(a.retired_park_id));
check(res(unseeded.retired_park_id)?.status === "alias", "never-materialised retired id resolves alias");
check(res(tombTax.retired_park_id)?.tombstone_status === "taxonomy_review" && res(tombNon.retired_park_id)?.tombstone_status === "non_park", "taxonomy_review / non_park tombstones resolve");
check(res(S)?.status === "live" && res("e9000000-0000-4000-8000-0000000000ff")?.status === "not_found", "live survivor + unknown id");
const ev = json(`select json_agg(json_build_object('id', e.id, 'park', e.park_id, 'point', e.point_id, 'point_active', fp.active, 'point_park', fp.park_id) order by e.id) from feeding_events e join feeding_points fp on fp.id = e.point_id where e.id::text like 'e2000000%'`);
check(ev.length === 3 && ev.every(e => e.park === S && e.point_park === S && e.point_active), "alias feeding events survive, moved to survivor, on active survivor points", ev);
check(ev.find(e => e.id.endsWith("0001")).point === S, "event on retired general point merged into survivor's general point (id = survivor id)");
check(ev.find(e => e.id.endsWith("0002")).point === "e1000000-0000-4000-8000-000000000001", "event on retired custom point keeps its (re-parented) point");
check(sql(`select active::text || '|' || park_id from feeding_points where id = ${q(R)}`) === `false|${R}`, "retired general point kept, inactive, no dependents", sql(`select count(*) from feeding_events where point_id = ${q(R)}`));
check(sql(`select park_id from feeding_points where id = 'e1000000-0000-4000-8000-000000000001'`) === S, "custom feeding point re-parented to survivor");
const obs = json(`select json_agg(json_build_object('id', o.id, 'point', o.point_id, 'point_park', fp.park_id)) from observations o join feeding_points fp on fp.id = o.point_id where o.id::text like 'e3000000%'`);
check(obs.length === 2 && obs.every(o => o.point_park === S), "observations survive, attached to survivor points", obs);
const fav = json(`select json_agg(json_build_object('u', user_id, 'p', park_id) order by user_id) from favorites where user_id in (${q(uA)}, ${q(uB)}) and park_id in (${q(R)}, ${q(S)})`);
check(fav.length === 2 && fav.every(f => f.p === S), "favorites moved to survivor; user A's duplicate merged into one row", fav);
const sug = json(`select json_object_agg(id, park_id::text || ':' || status) from park_name_suggestions where id::text like 'e4000000%'`);
check(sug["e4000000-0000-4000-8000-000000000001"] === `${S}:pending` && sug["e4000000-0000-4000-8000-000000000002"] === `${R}:pending` && sug["e4000000-0000-4000-8000-000000000004"] === `${R}:rejected`, "name suggestions: pending moved; conflicting pending + reviewed history stay on retired id", sug);
check(sql(`select count(*) from reports where id::text like 'e5000000%' and park_id = ${q(R)}`) === "2", "reports preserved against the reported (retired) id");
check(sql(`select count(*) from get_parks(${baseById.get(R).latitude - 0.01}, ${baseById.get(R).latitude + 0.01}, ${baseById.get(R).longitude - 0.01}, ${baseById.get(R).longitude + 0.01}) where id in (${q(R)}, ${q(tombTax.retired_park_id)})`) === "0", "get_parks excludes retired parks");
check(sql(`select count(*) from get_park(${q(R)})`) === "0" && sql(`select count(*) from get_park(${q(S)})`) === "1", "get_park: nothing for a retired id (client falls back to resolve_park_id), survivor served");
check(sql(`select count(*) from feeding_events e join feeding_points fp on fp.id = e.point_id where fp.park_id <> e.park_id`) === "0", "no feeding event points at another park's feeding point");
after = json(`select json_build_object('parks', (select count(*) from parks), 'active', (select count(*) from parks where active), 'inactive', (select count(*) from parks where not active),
  'release_live_active', (select count(*) from parks p where p.active and exists (select 1 from park_source_refs r where r.park_id = p.id)),
  'aliases', (select count(*) from canonical_park_aliases), 'tombstones', (select json_object_agg(status, n) from (select status, count(*) n from canonical_park_tombstones group by 1) x),
  'tombstone_refs', (select count(*) from canonical_park_tombstone_refs), 'reviews', (select count(*) from canonical_park_reviews), 'rejections', (select count(*) from canonical_park_rejections),
  'source_refs', (select count(*) from park_source_refs), 'releases', (select json_agg(release_id || ':' || status) from canonical_park_releases))`);
check(after.active === 26405 + 2, "active parks = 26,405 release parks + 2 untouched local fixtures", after);
const lifecycleTests = spawnSync("bash", ["-c", `${PSQL} -X -q -v ON_ERROR_STOP=1 -f - < ${path.join(root, "supabase/tests/canonical_park_lifecycle.test.sql")}`], { encoding: "utf8" });
check(lifecycleTests.status === 0 && !/FAIL/.test(lifecycleTests.stderr), "lifecycle schema tests still pass on the applied database", (lifecycleTests.stderr.match(/PASS/g) ?? []).length + " PASS");

} catch (e) {
  check(false, "test runner aborted", e.message);
} finally {
  /* ---------- 7. restore (always, unless --keep-applied) ---------- */
  if (!process.argv.includes("--keep-applied")) {
    restore();
    check(sameFp(fingerprint(), fp0), "local database restored byte-identically to the pre-test baseline");
  }
  execFileSync("docker", ["exec", CONTAINER, "rm", "-f", dumpFile]);
}
const summary = { start, seeded: fpSeeded && Object.fromEntries(Object.entries(fpSeeded).map(([t, v]) => [t, v.rows])), apply_report: applied?.report ?? null, after, passed: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length };
await writeFile(path.join(work, "summary.json"), JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed }));
process.exit(summary.failed ? 1 : 0);

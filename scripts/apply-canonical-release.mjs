import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBundle } from "./canonical-release-bundle.mjs";

// Single-transaction importer for a frozen canonical release bundle.
// The whole release (parks, refs, alias content moves, lifecycle rows, reviews,
// rejections, DB-only policy, invariants) runs in ONE psql session between BEGIN
// and COMMIT; any error aborts it, so a partial release cannot exist. Re-running an
// already-applied release with identical hashes is a no-op.
//
//   node scripts/apply-canonical-release.mjs --psql="docker exec -i supabase_db_patika psql -U postgres -d postgres" \
//        --environment=data/canonical-releases/environments/local.json [--release=<id>] [--bundle=<dir>] [--dry-run]
// Test-only: --inject-failure=<step>  --skip-precheck  --fingerprint (read-only table fingerprint, then exit)
// Refuses any non-local psql target unless --allow-remote is given explicitly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2), val = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null, flag = n => argv.includes(`--${n}`);
const psqlCmd = val("psql");
if (!psqlCmd) throw new Error("--psql=<command> is required (no default target)");
if (!/supabase_db_|127\.0\.0\.1|localhost/.test(psqlCmd) && !flag("allow-remote")) throw new Error("refusing a non-local database target without --allow-remote");

function psql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", `${psqlCmd} -X -q -At -v ON_ERROR_STOP=1`], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ out, err }) : reject(Object.assign(new Error(`psql exited ${code}: ${(err.match(/ERROR:.*$/m) ?? [err.trim().split("\n").pop()])[0]}`), { out, err })));
    child.stdin.on("error", () => {});   // psql may exit early on error; the close handler reports it
    child.stdin.end(sql);
  });
}

const FINGERPRINT_TABLES = ["parks", "park_source_refs", "feeding_points", "feeding_events", "observations", "favorites", "park_name_suggestions", "reports",
  "canonical_park_releases", "canonical_park_aliases", "canonical_park_tombstones", "canonical_park_tombstone_refs", "canonical_park_reviews", "canonical_park_rejections"];
async function fingerprint() {
  const sql = FINGERPRINT_TABLES.map(t => `select '${t}', count(*), coalesce(md5(string_agg(h, '' order by h)), '') from (select md5(x::text) h from public.${t} x) s;`).join("\n");
  const { out } = await psql(sql);
  return Object.fromEntries(out.trim().split("\n").map(l => l.split("|")).map(([t, n, h]) => [t, { rows: Number(n), md5: h }]));
}
if (flag("fingerprint")) { console.log(JSON.stringify(await fingerprint(), null, 1)); process.exit(0); }

/* ---------- 1. bundle validation (hard failure on any mismatch) ---------- */
const releaseId = val("release") ?? "patika-parks-2026-09-27-rc1";
const cfg = JSON.parse(await readFile(path.join(root, "data/canonical-releases", `${releaseId}.json`), "utf8"));
if (!cfg.expected_manifest_sha256) throw new Error(`release ${releaseId} has no frozen expected_manifest_sha256`);
const bundleDir = path.resolve(val("bundle") ?? path.join(root, "data/park-enrichment/.cache/releases", releaseId));
const { manifest, manifestSha256, data } = await validateBundle(bundleDir, { expectedManifestSha256: cfg.expected_manifest_sha256, expectedCounts: cfg.expected_counts, releaseId });
const envPath = val("environment");
if (!envPath) throw new Error("--environment=<policy file> is required (DB-only park policy of the target environment)");
const env = JSON.parse(await readFile(path.resolve(envPath), "utf8"));

/* ---------- 2. read-only pre-check: already applied? ---------- */
if (!flag("skip-precheck")) {
  const { out } = await psql(`select coalesce((select status || '|' || manifest_sha256 || '|' || base_snapshot_sha256 from public.canonical_park_releases where release_id = '${manifest.release_id}'), 'absent');`);
  const state = out.trim();
  if (state !== "absent") {
    const [status, m, b] = state.split("|");
    if (status === "applied" && m === manifestSha256 && b === manifest.base_snapshot_sha256) {
      console.log(JSON.stringify({ release_id: manifest.release_id, result: "NO-OP", reason: "release already applied with identical manifest and base hashes; nothing was written" }));
      process.exit(0);
    }
    throw new Error(`release ${manifest.release_id} is recorded with status=${status} and different hashes; refusing`);
  }
}

/* ---------- 3. one transaction ---------- */
const lit = s => `$lit$${s}$lit$`;
const meta = {
  release_id: manifest.release_id, manifest_sha256: manifestSha256, base_snapshot_sha256: manifest.base_snapshot_sha256,
  expected_counts: manifest.expected_counts, source_scope: manifest.source_scope, schema_migration: manifest.prerequisites.schema_migration,
  required_tables: manifest.prerequisites.tables, required_functions: manifest.prerequisites.functions, environment: env.environment,
  inject_failure: val("inject-failure")
};
const copyEsc = s => s.replace(/\\/g, "\\\\");
const rows = [];
for (const [kind, list] of Object.entries(data)) for (const r of list) rows.push(`${kind}\t${copyEsc(JSON.stringify(r))}`);
for (const f of env.fixtures ?? []) rows.push(`env_fixture\t${copyEsc(JSON.stringify(f))}`);
for (const id of env.tombstone_user_content_ack ?? []) rows.push(`env_tombstone_ack\t${copyEsc(JSON.stringify(id))}`);
const applySql = await readFile(path.join(root, "scripts/sql/apply-canonical-release.sql"), "utf8");
const sql = [
  "begin;",
  "select pg_advisory_xact_lock(hashtextextended('patika:canonical-release', 0));",
  "create temp table stg_meta(k text primary key, v jsonb) on commit drop;",
  ...Object.entries(meta).map(([k, v]) => `insert into stg_meta values (${lit(k)}, ${lit(JSON.stringify(v ?? null))}::jsonb);`),
  "create temp table stg_raw(kind text not null, doc jsonb not null) on commit drop;",
  "copy stg_raw(kind, doc) from stdin;",
  ...rows,
  "\\.",
  applySql,
  "select 'REPORT:' || jsonb_object_agg(k, v)::text from rpt;",
  flag("dry-run") ? "rollback;" : "commit;"
].join("\n") + "\n";

const started = Date.now();
try {
  const { out } = await psql(sql);
  const line = out.split("\n").find(l => l.startsWith("REPORT:"));
  const report = line ? JSON.parse(line.slice(7)) : null;
  console.log(JSON.stringify({ release_id: manifest.release_id, manifest_sha256: manifestSha256, result: flag("dry-run") ? "DRY-RUN (rolled back)" : "APPLIED (committed)", seconds: Math.round((Date.now() - started) / 100) / 10, report }, null, 1));
} catch (e) {
  console.error(JSON.stringify({ release_id: manifest.release_id, result: "FAILED — transaction rolled back, nothing applied", error: e.message }, null, 1));
  process.exit(1);
}

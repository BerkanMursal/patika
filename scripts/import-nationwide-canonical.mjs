import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const require = createRequire(
  path.join(root, "mobile/package.json")
);

const inputPath =
  process.env.NATIONWIDE_CANONICAL_PREVIEW ||
  path.join(
    root,
    "data/park-enrichment/.cache/nationwide-canonical-preview.json"
  );

const detailsPath = path.join(
  root,
  "mobile/src/core/park-details.json"
);

// Nationwide covers every province at once, so — unlike the İzmir importer,
// which defaults to a real write — this script only ever writes to the
// database when both SUPABASE credentials AND --commit are given explicitly.
const commit = process.argv.includes("--commit");

const document = JSON.parse(
  await readFile(inputPath, "utf8")
);

let details = {};

try {
  details = JSON.parse(
    await readFile(detailsPath, "utf8")
  );
} catch {
  details = {};
}

if (document.mode !== "nationwide-canonical-preview") {
  throw new Error(
    `Unexpected dataset mode: ${document.mode}`
  );
}

if (!Array.isArray(document.parks) || document.parks.length === 0) {
  throw new Error("Canonical dataset contains no parks.");
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isUnnamed(value) {
  return !clean(value) || clean(value) === "İsimsiz park";
}

const importedAt = document.generatedAt || new Date().toISOString();

/* ---------------------------------------
   Normalize parks
--------------------------------------- */

const parks = document.parks.map(park => {
  if (!park.id) {
    throw new Error(`Park missing id: ${JSON.stringify(park)}`);
  }

  if (!clean(park.name)) {
    throw new Error(`Park ${park.id} has no name.`);
  }

  if (
    !Number.isFinite(park.latitude) ||
    !Number.isFinite(park.longitude)
  ) {
    throw new Error(`Park ${park.id} has invalid coordinates.`);
  }

  const osmBacked = Boolean(park.osm_id);
  const extra = osmBacked ? details[park.id] ?? {} : {};

  const base = {
    id: park.id,
    osm_id: park.osm_id ?? null,
    name: clean(park.name),
    city: clean(park.city) || "",
    district: clean(park.district),
    latitude: park.latitude,
    longitude: park.longitude,
    active: true,
    source: osmBacked
      ? "OpenStreetMap"
      : park.source || "Belediye kaynağı",
    imported_at: importedAt,
    name_status:
      park.name_status ??
      (osmBacked ? (isUnnamed(park.name) ? "missing" : "source") : "municipal"),
    name_source:
      park.name_source ??
      (osmBacked ? "OpenStreetMap" : park.source || "Belediye kaynağı"),
    name_source_url:
      park.name_source_url ??
      (osmBacked ? `https://www.openstreetmap.org/${park.osm_id}` : ""),
    address_label: ""
  };

  // Details enrichment (address labels etc.) must never override canonical
  // identity/name fields — same rule as import-izmir-canonical.mjs.
  if (osmBacked) Object.assign(base, extra);
  base.id = park.id;
  base.osm_id = park.osm_id ?? null;
  base.name = clean(park.name);
  base.city = clean(park.city) || "";
  base.district = clean(park.district);
  base.latitude = park.latitude;
  base.longitude = park.longitude;

  return base;
});

/* ---------------------------------------
   Normalize provenance
--------------------------------------- */

const sourceRefs = [];

for (const park of document.parks) {
  for (const ref of park.source_refs ?? []) {
    if (!clean(ref.source_code) || !clean(ref.external_id)) {
      throw new Error(`Invalid source ref on park ${park.id}`);
    }

    sourceRefs.push({
      source_code: clean(ref.source_code),
      external_id: clean(ref.external_id),
      park_id: park.id,
      source_url: clean(ref.source_url),
      metadata: {}
    });
  }
}

/* ---------------------------------------
   Feeding points
--------------------------------------- */

const feedingPoints = parks.map(park => ({
  id: park.id,
  park_id: park.id,
  name: "Park içi genel nokta",
  latitude: park.latitude,
  longitude: park.longitude,
  active: true
}));

/* ---------------------------------------
   Local invariants (defense in depth —
   build-nationwide-canonical.mjs already
   enforces these, this re-checks the file
   actually being imported).
--------------------------------------- */

function duplicates(values) {
  const seen = new Set();
  const dup = new Set();

  for (const value of values) {
    if (seen.has(value)) dup.add(value);
    seen.add(value);
  }

  return [...dup];
}

const duplicateParkIds = duplicates(parks.map(p => p.id));
const duplicateOsmIds = duplicates(
  parks.filter(p => p.osm_id).map(p => p.osm_id)
);
const duplicateRefs = duplicates(
  sourceRefs.map(ref => `${ref.source_code}:${ref.external_id}`)
);

if (duplicateParkIds.length) {
  throw new Error(`Duplicate park IDs: ${duplicateParkIds.slice(0, 10)}`);
}

if (duplicateOsmIds.length) {
  throw new Error(`Duplicate OSM IDs: ${duplicateOsmIds.slice(0, 10)}`);
}

if (duplicateRefs.length) {
  throw new Error(`Duplicate source refs: ${duplicateRefs.slice(0, 10)}`);
}

const osmParks = parks.filter(p => p.osm_id);
const municipalOnly = parks.filter(p => !p.osm_id);
const emptyDistricts = parks.filter(p => !clean(p.district));
const emptyCities = parks.filter(p => !clean(p.city));

const byProvince = new Map();
for (const park of parks) {
  const key = park.city || "(atanmamış)";
  byProvince.set(key, (byProvince.get(key) ?? 0) + 1);
}

const summary = {
  input: inputPath,
  commit,
  parks: parks.length,
  osmBackedParks: osmParks.length,
  municipalOnlyParks: municipalOnly.length,
  sourceRefs: sourceRefs.length,
  feedingPoints: feedingPoints.length,
  parksWithoutDistrict: emptyDistricts.length,
  parksWithoutCity: emptyCities.length,
  provincesRepresented: byProvince.size,
  duplicateParkIds: duplicateParkIds.length,
  duplicateOsmIds: duplicateOsmIds.length,
  duplicateSourceRefs: duplicateRefs.length
};

console.log("===== NATIONWIDE CANONICAL IMPORT =====");
console.log(summary);

if (!commit) {
  console.log(
    "\nDRY RUN COMPLETE — database was not modified. " +
      "Pass --commit (with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set) to write."
  );
  process.exit(0);
}

/* ---------------------------------------
   Database (only reached with --commit)
--------------------------------------- */

const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before a real import."
  );
}

const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});

/* ---------------------------------------
   Preflight DB identity conflicts
--------------------------------------- */

const existingById = new Map();

for (let i = 0; i < parks.length; i += 200) {
  const ids = parks.slice(i, i + 200).map(p => p.id);

  const { data, error } = await client
    .from("parks")
    .select("id,osm_id,name")
    .in("id", ids);

  if (error) throw error;

  for (const row of data ?? []) {
    existingById.set(row.id, row);
  }
}

for (const park of parks) {
  const existing = existingById.get(park.id);
  if (!existing) continue;

  if ((existing.osm_id ?? null) !== (park.osm_id ?? null)) {
    throw new Error(
      `Canonical ID conflict for ${park.id}: DB osm_id=${existing.osm_id}, dataset osm_id=${park.osm_id}`
    );
  }
}

const osmIds = osmParks.map(p => p.osm_id);

for (let i = 0; i < osmIds.length; i += 200) {
  const batch = osmIds.slice(i, i + 200);

  const { data, error } = await client
    .from("parks")
    .select("id,osm_id")
    .in("osm_id", batch);

  if (error) throw error;

  for (const row of data ?? []) {
    const expected = osmParks.find(park => park.osm_id === row.osm_id);

    if (expected && expected.id !== row.id) {
      throw new Error(
        `OSM identity conflict ${row.osm_id}: DB=${row.id}, canonical=${expected.id}`
      );
    }
  }
}

const existingRefs = [];

for (let from = 0; ; from += 1000) {
  const { data, error } = await client
    .from("park_source_refs")
    .select("source_code,external_id,park_id")
    .range(from, from + 999);

  if (error) throw error;

  existingRefs.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

const existingRefMap = new Map(
  existingRefs.map(ref => [
    `${ref.source_code}:${ref.external_id}`,
    ref.park_id
  ])
);

for (const ref of sourceRefs) {
  const key = `${ref.source_code}:${ref.external_id}`;
  const existingParkId = existingRefMap.get(key);

  if (existingParkId && existingParkId !== ref.park_id) {
    throw new Error(
      `Source ref conflict ${key}: DB=${existingParkId}, canonical=${ref.park_id}`
    );
  }
}

console.log("\nPreflight identity checks passed.");

/* ---------------------------------------
   Upsert parks
--------------------------------------- */

for (let i = 0; i < parks.length; i += 200) {
  const batch = parks.slice(i, i + 200);
  const { error } = await client.from("parks").upsert(batch, { onConflict: "id" });
  if (error) throw error;
  console.log(`Parks ${Math.min(i + 200, parks.length)}/${parks.length}`);
}

/* ---------------------------------------
   Upsert source refs
--------------------------------------- */

const refTimestamp = new Date().toISOString();

for (let i = 0; i < sourceRefs.length; i += 300) {
  const batch = sourceRefs
    .slice(i, i + 300)
    .map(ref => ({ ...ref, last_seen_at: refTimestamp }));

  const { error } = await client
    .from("park_source_refs")
    .upsert(batch, {
      onConflict: "source_code,external_id",
      defaultToNull: false
    });

  if (error) throw error;
  console.log(`Source refs ${Math.min(i + 300, sourceRefs.length)}/${sourceRefs.length}`);
}

/* ---------------------------------------
   Ensure default feeding point
--------------------------------------- */

for (let i = 0; i < feedingPoints.length; i += 200) {
  const batch = feedingPoints.slice(i, i + 200);

  const { error } = await client
    .from("feeding_points")
    .upsert(batch, { onConflict: "park_id,name", ignoreDuplicates: true });

  if (error) throw error;
  console.log(`Feeding points ${Math.min(i + 200, feedingPoints.length)}/${feedingPoints.length}`);
}

console.log("\n===== IMPORT COMPLETE =====");
console.log({
  parks: parks.length,
  sourceRefs: sourceRefs.length,
  feedingPointsEnsured: feedingPoints.length
});

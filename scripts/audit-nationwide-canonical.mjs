import { readFile, writeFile } from "node:fs/promises";
import { nameKey, distanceMeters } from "./park-enrichment.mjs";

const previewPath =
  process.env.NATIONWIDE_CANONICAL_PREVIEW ||
  new URL(
    "../data/park-enrichment/.cache/nationwide-canonical-preview.json",
    import.meta.url
  );

const outputPath =
  process.env.NATIONWIDE_CANONICAL_AUDIT ||
  new URL(
    "../data/park-enrichment/.cache/nationwide-canonical-audit.json",
    import.meta.url
  );

const preview = JSON.parse(
  await readFile(previewPath, "utf8")
);

if (preview.mode !== "nationwide-canonical-preview") {
  throw new Error(
    `Unexpected dataset mode: ${preview.mode}`
  );
}

const parks = preview.parks;

function entityType(park) {
  return park.osm_id ? park.osm_id.split("/")[0] : "municipal";
}

/* -------------------------------------------------
   Missing name / district — review candidates, no
   auto-fill.
------------------------------------------------- */

function isUnnamed(name) {
  const key = nameKey(name);
  return !key || key === nameKey("İsimsiz park");
}

const missingName = parks.filter(p => isUnnamed(p.name));
const missingDistrict = parks.filter(p => !p.district?.trim());

/* -------------------------------------------------
   Possible-duplicate detection: two different
   canonical parks whose points are within 40m of
   each other. This flags candidates for human
   review — it never merges anything automatically.
   A grid bucket (~0.01 degree, ~1km at TR latitudes)
   keeps this near-linear across 24k+ points instead
   of the O(n^2) pairwise scan the İzmir-only audits
   could afford at 1-2k points.
------------------------------------------------- */

const CELL = 0.01;
const THRESHOLD_METERS = 40;

function cellKey(park) {
  const x = Math.floor(park.longitude / CELL);
  const y = Math.floor(park.latitude / CELL);
  return `${x}:${y}`;
}

const buckets = new Map();

for (const park of parks) {
  const key = cellKey(park);
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(park);
}

function neighborKeys(park) {
  const x = Math.floor(park.longitude / CELL);
  const y = Math.floor(park.latitude / CELL);
  const keys = [];

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      keys.push(`${x + dx}:${y + dy}`);
    }
  }

  return keys;
}

const seenPairs = new Set();
const possibleDuplicates = [];

for (const park of parks) {
  const candidates = neighborKeys(park).flatMap(
    key => buckets.get(key) ?? []
  );

  for (const other of candidates) {
    if (other.id === park.id) continue;

    const pairKey =
      park.id < other.id
        ? `${park.id}|${other.id}`
        : `${other.id}|${park.id}`;

    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const distance = distanceMeters(park, other);
    if (distance > THRESHOLD_METERS) continue;

    const pairType = [entityType(park), entityType(other)]
      .sort()
      .join("+");

    possibleDuplicates.push({
      province: park.city || other.city || "(atanmamış)",
      pair_type: pairType,
      a: { id: park.id, osm_id: park.osm_id, name: park.name },
      b: { id: other.id, osm_id: other.osm_id, name: other.name },
      distance_m: Math.round(distance),
      same_name: Boolean(
        nameKey(park.name) &&
          nameKey(park.name) === nameKey(other.name)
      )
    });
  }
}

possibleDuplicates.sort((a, b) => a.distance_m - b.distance_m);

const byProvince = new Map();
const byPairType = new Map();

for (const dup of possibleDuplicates) {
  byProvince.set(
    dup.province,
    (byProvince.get(dup.province) ?? 0) + 1
  );

  byPairType.set(
    dup.pair_type,
    (byPairType.get(dup.pair_type) ?? 0) + 1
  );
}

const summary = {
  totalParks: parks.length,
  missingName: missingName.length,
  missingDistrict: missingDistrict.length,
  possibleDuplicatePairs: possibleDuplicates.length,
  possibleDuplicatePairsWithMatchingName: possibleDuplicates.filter(
    d => d.same_name
  ).length,
  possibleDuplicatesByPairType: Object.fromEntries(byPairType),
  provincesWithPossibleDuplicates: byProvince.size
};

const output = {
  generatedAt: new Date().toISOString(),
  sourceSnapshot: String(previewPath),
  thresholdMeters: THRESHOLD_METERS,
  summary,
  possibleDuplicates,
  missingDistrictSample: missingDistrict.slice(0, 30).map(p => ({
    id: p.id,
    name: p.name,
    city: p.city,
    latitude: p.latitude,
    longitude: p.longitude
  }))
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== NATIONWIDE CANONICAL AUDIT =====");
console.log(summary);

console.log(
  "\n===== TOP PROVINCES BY POSSIBLE DUPLICATES ====="
);

console.log(
  [...byProvince.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
);

console.log(`\nSaved -> ${outputPath}`);

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const oldCatalogPath = new URL(
  "../mobile/src/core/parks.json",
  import.meta.url
);

const newCatalogPath =
  process.env.NATIONWIDE_PBF_BASELINE ||
  new URL(
    "../data/park-enrichment/.cache/geofabrik/nationwide-pbf-catalog.json",
    import.meta.url
  );

const outputPath =
  process.env.NATIONWIDE_PBF_DIFF_OUTPUT ||
  new URL(
    "../data/park-enrichment/.cache/geofabrik/nationwide-pbf-diff.json",
    import.meta.url
  );

const oldRows = JSON.parse(await readFile(oldCatalogPath, "utf8"));
const newDocument = JSON.parse(await readFile(newCatalogPath, "utf8"));

if (newDocument.mode !== "nationwide-pbf-baseline") {
  throw new Error(`Unexpected dataset mode: ${newDocument.mode}`);
}

function deterministicUuid(value) {
  const bytes = createHash("sha256")
    .update(value)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

const oldById = new Map(
  oldRows.map(row => [
    row[1],
    {
      id: row[0],
      osm_id: row[1],
      name: row[2],
      city: row[3],
      district: row[4],
      latitude: row[5],
      longitude: row[6]
    }
  ])
);

const newById = new Map(newDocument.rows.map(row => [row.osm_id, row]));

const oldOsmIds = new Set(oldById.keys());
const newOsmIds = new Set(newById.keys());

const unchangedOsmIds = [...oldOsmIds].filter(id => newOsmIds.has(id));
const newOnlyOsmIds = [...newOsmIds].filter(id => !oldOsmIds.has(id));
const removedOsmIds = [...oldOsmIds].filter(id => !newOsmIds.has(id));

/* -------------------------------------------------
   For every OSM id present in both snapshots: the
   deterministic ID must be identical (id stability
   depends only on osm_id, never on coordinates/name/
   province), and we report what else changed.
------------------------------------------------- */

const idChanges = [];
const nameChanges = [];
const coordinateChanges = [];
const provinceChanges = [];
const districtChanges = [];

const COORDINATE_EPSILON = 0.0000005; // ~5cm; catches representative-point
                                       // shifts from the new point-on-surface
                                       // algorithm vs. the old first-node pick.

for (const osmId of unchangedOsmIds) {
  const oldRow = oldById.get(osmId);
  const newRow = newById.get(osmId);

  const expectedId = deterministicUuid(`patika-osm:${osmId}`);

  if (oldRow.id !== expectedId || newRow.id !== expectedId) {
    idChanges.push({
      osm_id: osmId,
      old_id: oldRow.id,
      new_id: newRow.id,
      expected_id: expectedId
    });
  }

  if (oldRow.name !== newRow.name) {
    nameChanges.push({ osm_id: osmId, old_name: oldRow.name, new_name: newRow.name });
  }

  if (
    Math.abs(oldRow.latitude - newRow.latitude) > COORDINATE_EPSILON ||
    Math.abs(oldRow.longitude - newRow.longitude) > COORDINATE_EPSILON
  ) {
    coordinateChanges.push({
      osm_id: osmId,
      old: { latitude: oldRow.latitude, longitude: oldRow.longitude },
      new: { latitude: newRow.latitude, longitude: newRow.longitude }
    });
  }

  if ((oldRow.city || "") !== (newRow.city || "")) {
    provinceChanges.push({ osm_id: osmId, old_city: oldRow.city, new_city: newRow.city });
  }

  if ((oldRow.district || "") !== (newRow.district || "")) {
    districtChanges.push({
      osm_id: osmId,
      old_district: oldRow.district,
      new_district: newRow.district
    });
  }
}

const summary = {
  oldOsmParks: oldRows.length,
  newOsmParks: newDocument.rows.length,
  unchangedOsmIds: unchangedOsmIds.length,
  newOsmIds: newOnlyOsmIds.length,
  removedOsmIds: removedOsmIds.length,
  sameOsmIdChangedName: nameChanges.length,
  sameOsmIdChangedCoordinate: coordinateChanges.length,
  sameOsmIdChangedProvince: provinceChanges.length,
  sameOsmIdChangedDistrict: districtChanges.length,
  idChanges: idChanges.length,
  pbfSnapshot: newDocument.pbfSource,
  oldSnapshotFetchedAt: null
};

try {
  const rawOld = JSON.parse(
    await readFile(
      new URL("../data/parks-turkey.json", import.meta.url),
      "utf8"
    )
  );
  summary.oldSnapshotFetchedAt = rawOld.fetchedAt ?? null;
} catch {
  // Optional context only.
}

const output = {
  generatedAt: new Date().toISOString(),
  summary,
  removedOsmIdsSample: removedOsmIds.slice(0, 50),
  newOsmIdsSample: newOnlyOsmIds.slice(0, 50),
  idChanges,
  nameChanges: nameChanges.slice(0, 50),
  coordinateChanges: coordinateChanges.slice(0, 50),
  provinceChanges,
  districtChanges: districtChanges.slice(0, 50)
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== OLD vs NEW OSM BASELINE DIFF =====");
console.log(summary);

if (idChanges.length) {
  console.log("\n!!! DETERMINISTIC ID CHANGED — this must never happen !!!");
  console.dir(idChanges.slice(0, 10), { depth: null });
}

console.log(`\nSaved -> ${outputPath}`);

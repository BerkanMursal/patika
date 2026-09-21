import { readFile } from "node:fs/promises";

const defaultPbfPath = new URL(
  "../data/park-enrichment/.cache/geofabrik/nationwide-pbf-catalog.json",
  import.meta.url
);

const defaultLegacyPath = new URL(
  "../mobile/src/core/parks.json",
  import.meta.url
);

// Shared by build-nationwide-canonical.mjs and build-izmir-canonical-reconciled.mjs
// so both pick the same OSM source the same way: the reproducible Geofabrik PBF
// baseline when it exists, else the committed Overpass catalog. Always returns
// rows as [id, osm_id, name, city, district, latitude, longitude] tuples.
export async function loadNationwideOsmSource({
  pbfPath = process.env.NATIONWIDE_PBF_BASELINE || defaultPbfPath,
  legacyPath = defaultLegacyPath
} = {}) {
  try {
    const pbf = JSON.parse(await readFile(pbfPath, "utf8"));

    if (pbf.mode !== "nationwide-pbf-baseline") {
      throw new Error(`Unexpected dataset mode: ${pbf.mode}`);
    }

    const rows = pbf.rows.map(row => [
      row.id,
      row.osm_id,
      row.name,
      row.city,
      row.district,
      row.latitude,
      row.longitude
    ]);

    return {
      rows,
      label: `pbf:${pbf.pbfSource.resolvedFilename}`,
      pbfSource: pbf.pbfSource
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    const rows = JSON.parse(await readFile(legacyPath, "utf8"));
    return { rows, label: "legacy-overpass-catalog", pbfSource: null };
  }
}

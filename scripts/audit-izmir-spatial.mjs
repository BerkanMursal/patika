import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "./park-enrichment.mjs";

const officialPath =
  process.env.IZMIR_OFFICIAL_SNAPSHOT ||
  new URL(
    "../data/park-enrichment/.cache/izmir-official-parks.json",
    import.meta.url
  );

const outputPath =
  process.env.IZMIR_SPATIAL_AUDIT ||
  new URL(
    "../data/park-enrichment/.cache/izmir-spatial-audit.json",
    import.meta.url
  );

const catalogPath =
  new URL(
    "../mobile/src/core/parks.json",
    import.meta.url
  );

const official = JSON.parse(
  await readFile(officialPath, "utf8")
);

const catalog = JSON.parse(
  await readFile(catalogPath, "utf8")
);

const osm = catalog
  .filter(row => row[3] === "İzmir")
  .map(row => ({
    id: row[0],
    osm_id: row[1],
    name: row[2],
    city: row[3],
    district: row[4],
    latitude: row[5],
    longitude: row[6]
  }))
  .filter(
    p =>
      Number.isFinite(p.latitude) &&
      Number.isFinite(p.longitude)
  );

function pointInRing(lon, lat, ring) {
  let inside = false;

  for (
    let i = 0, j = ring.length - 1;
    i < ring.length;
    j = i++
  ) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersects =
      (yi > lat) !== (yj > lat) &&
      lon <
        ((xj - xi) * (lat - yi)) /
          (yj - yi) +
          xi;

    if (intersects)
      inside = !inside;
  }

  return inside;
}

function pointInArcPolygon(lon, lat, rings) {
  let hits = 0;

  for (const ring of rings ?? []) {
    if (pointInRing(lon, lat, ring))
      hits++;
  }

  return hits % 2 === 1;
}

const officialRows = [];
const osmContainers = new Map(
  osm.map(p => [p.osm_id, []])
);

for (
  let i = 0;
  i < official.features.length;
  i++
) {
  const feature =
    official.features[i];

  const objectid =
    feature.attributes.OBJECTID;

  const officialName =
    String(
      feature.attributes.ADI ?? ""
    ).trim() || null;

  const rings =
    feature.geometry?.rings ?? [];

  const contained = [];

  if (rings.length) {
    const allPoints = rings.flat();

    const minLon =
      Math.min(...allPoints.map(p => p[0]));

    const maxLon =
      Math.max(...allPoints.map(p => p[0]));

    const minLat =
      Math.min(...allPoints.map(p => p[1]));

    const maxLat =
      Math.max(...allPoints.map(p => p[1]));

    for (const park of osm) {
      if (
        park.longitude < minLon ||
        park.longitude > maxLon ||
        park.latitude < minLat ||
        park.latitude > maxLat
      ) {
        continue;
      }

      if (
        pointInArcPolygon(
          park.longitude,
          park.latitude,
          rings
        )
      ) {
        contained.push({
          osm_id: park.osm_id,
          osm_name: park.name,
          latitude: park.latitude,
          longitude: park.longitude
        });

        osmContainers
          .get(park.osm_id)
          .push(objectid);
      }
    }
  }

  officialRows.push({
    objectid,
    official_name: officialName,
    contained_osm: contained,
    contained_count: contained.length
  });

  if (
    (i + 1) % 250 === 0 ||
    i + 1 === official.features.length
  ) {
    console.log(
      `Processed ${i + 1}/${official.features.length}`
    );
  }
}

const reciprocalUnique = [];

for (const row of officialRows) {
  if (row.contained_osm.length !== 1)
    continue;

  const candidate =
    row.contained_osm[0];

  const containingOfficial =
    osmContainers.get(
      candidate.osm_id
    ) ?? [];

  if (containingOfficial.length !== 1)
    continue;

  reciprocalUnique.push({
    objectid: row.objectid,
    official_name:
      row.official_name,
    osm_id:
      candidate.osm_id,
    osm_name:
      candidate.osm_name,
    exact_name:
      Boolean(
        row.official_name &&
        nameKey(row.official_name) ===
          nameKey(candidate.osm_name)
      )
  });
}

const summary = {
  officialTotal:
    officialRows.length,

  osmIzmirTotal:
    osm.length,

  officialContainingZeroOsmCenters:
    officialRows.filter(
      r => r.contained_count === 0
    ).length,

  officialContainingExactlyOneOsmCenter:
    officialRows.filter(
      r => r.contained_count === 1
    ).length,

  officialContainingMultipleOsmCenters:
    officialRows.filter(
      r => r.contained_count > 1
    ).length,

  reciprocalUniqueSpatialMatches:
    reciprocalUnique.length,

  reciprocalUniqueExactNameMatches:
    reciprocalUnique.filter(
      r => r.exact_name
    ).length,

  reciprocalUniqueDifferentNames:
    reciprocalUnique.filter(
      r => !r.exact_name
    ).length,

  osmOutsideAllOfficialPolygons:
    [...osmContainers.values()]
      .filter(ids => ids.length === 0)
      .length,

  osmInsideMultipleOfficialPolygons:
    [...osmContainers.values()]
      .filter(ids => ids.length > 1)
      .length
};

const output = {
  generatedAt:
    new Date().toISOString(),

  sourceSnapshot:
    String(officialPath),

  summary,

  official:
    officialRows,

  osm:
    osm.map(park => ({
      ...park,
      containing_official_objectids:
        osmContainers.get(
          park.osm_id
        ) ?? []
    })),

  reciprocalUnique
};

await writeFile(
  outputPath,
  JSON.stringify(output, null, 2)
);

console.log(
  "\n===== İZMİR SPATIAL AUDIT ====="
);

console.log(summary);

console.log(
  `\nSaved -> ${String(outputPath)}`
);

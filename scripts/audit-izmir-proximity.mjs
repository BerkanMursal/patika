import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "./park-enrichment.mjs";

const officialPath =
  process.env.IZMIR_OFFICIAL_SNAPSHOT ||
  new URL(
    "../data/park-enrichment/.cache/izmir-official-parks.json",
    import.meta.url
  );

const spatialPath =
  process.env.IZMIR_SPATIAL_AUDIT ||
  new URL(
    "../data/park-enrichment/.cache/izmir-spatial-audit.json",
    import.meta.url
  );

const outputPath =
  process.env.IZMIR_PROXIMITY_AUDIT ||
  new URL(
    "../data/park-enrichment/.cache/izmir-proximity-audit.json",
    import.meta.url
  );

const official = JSON.parse(
  await readFile(officialPath, "utf8")
);

const spatial = JSON.parse(
  await readFile(spatialPath, "utf8")
);

const catalog = JSON.parse(
  await readFile(
    new URL(
      "../mobile/src/core/parks.json",
      import.meta.url
    ),
    "utf8"
  )
);

const osm = catalog
  .filter(row => row[3] === "İzmir")
  .map(row => ({
    osm_id: row[1],
    osm_name: row[2],
    latitude: row[5],
    longitude: row[6]
  }))
  .filter(
    row =>
      Number.isFinite(row.latitude) &&
      Number.isFinite(row.longitude)
  );

const officialById = new Map(
  official.features.map(feature => [
    feature.attributes.OBJECTID,
    feature
  ])
);

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = Array.from(
    { length: b.length + 1 },
    (_, i) => i
  );

  const curr = new Array(
    b.length + 1
  );

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;

    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] +
          (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }

    for (let j = 0; j <= b.length; j++)
      prev[j] = curr[j];
  }

  return prev[b.length];
}

function nameSimilarity(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);

  if (!x || !y)
    return 0;

  if (x === y)
    return 1;

  const maxLength =
    Math.max(x.length, y.length);

  if (!maxLength)
    return 0;

  return Math.max(
    0,
    1 -
      levenshtein(x, y) /
        maxLength
  );
}

function metersPerLon(lat) {
  return (
    111320 *
    Math.cos(
      lat * Math.PI / 180
    )
  );
}

function pointSegmentDistanceMeters(
  pointLon,
  pointLat,
  a,
  b
) {
  const lat0 =
    (pointLat + a[1] + b[1]) / 3;

  const mx =
    metersPerLon(lat0);

  const my = 110540;

  const px =
    pointLon * mx;

  const py =
    pointLat * my;

  const ax =
    a[0] * mx;

  const ay =
    a[1] * my;

  const bx =
    b[0] * mx;

  const by =
    b[1] * my;

  const abx = bx - ax;
  const aby = by - ay;

  const apx = px - ax;
  const apy = py - ay;

  const denominator =
    abx * abx + aby * aby;

  let t =
    denominator === 0
      ? 0
      : (
          apx * abx +
          apy * aby
        ) / denominator;

  t = Math.max(
    0,
    Math.min(1, t)
  );

  const dx =
    px - (ax + t * abx);

  const dy =
    py - (ay + t * aby);

  return Math.hypot(dx, dy);
}

function distanceToPolygonMeters(
  lon,
  lat,
  rings
) {
  let best = Infinity;

  for (const ring of rings ?? []) {
    for (
      let i = 0;
      i < ring.length - 1;
      i++
    ) {
      const distance =
        pointSegmentDistanceMeters(
          lon,
          lat,
          ring[i],
          ring[i + 1]
        );

      if (distance < best)
        best = distance;
    }

    if (
      ring.length > 2 &&
      (
        ring[0][0] !==
          ring[ring.length - 1][0] ||
        ring[0][1] !==
          ring[ring.length - 1][1]
      )
    ) {
      const distance =
        pointSegmentDistanceMeters(
          lon,
          lat,
          ring[ring.length - 1],
          ring[0]
        );

      if (distance < best)
        best = distance;
    }
  }

  return best;
}

const zeroContainment =
  spatial.official.filter(
    row =>
      row.contained_count === 0
  );

const results = [];

for (
  let index = 0;
  index < zeroContainment.length;
  index++
) {
  const spatialRow =
    zeroContainment[index];

  const feature =
    officialById.get(
      spatialRow.objectid
    );

  if (!feature)
    throw new Error(
      `Official feature missing: ${spatialRow.objectid}`
    );

  const rings =
    feature.geometry?.rings ?? [];

  const points =
    rings.flat();

  if (!points.length) {
    results.push({
      objectid:
        spatialRow.objectid,

      official_name:
        spatialRow.official_name,

      candidates: []
    });

    continue;
  }

  const minLon =
    Math.min(
      ...points.map(p => p[0])
    );

  const maxLon =
    Math.max(
      ...points.map(p => p[0])
    );

  const minLat =
    Math.min(
      ...points.map(p => p[1])
    );

  const maxLat =
    Math.max(
      ...points.map(p => p[1])
    );

  const centerLat =
    (minLat + maxLat) / 2;

  const latPadding =
    350 / 110540;

  const lonPadding =
    350 /
    Math.max(
      1,
      metersPerLon(centerLat)
    );

  const candidates = [];

  for (const park of osm) {
    if (
      park.longitude <
        minLon - lonPadding ||
      park.longitude >
        maxLon + lonPadding ||
      park.latitude <
        minLat - latPadding ||
      park.latitude >
        maxLat + latPadding
    ) {
      continue;
    }

    const distance =
      distanceToPolygonMeters(
        park.longitude,
        park.latitude,
        rings
      );

    if (
      !Number.isFinite(distance) ||
      distance > 300
    ) {
      continue;
    }

    const similarity =
      nameSimilarity(
        spatialRow.official_name,
        park.osm_name
      );

    candidates.push({
      osm_id:
        park.osm_id,

      osm_name:
        park.osm_name,

      distance_m:
        Math.round(distance),

      exact_name:
        Boolean(
          spatialRow.official_name &&
          nameKey(
            spatialRow.official_name
          ) ===
            nameKey(
              park.osm_name
            )
        ),

      name_similarity:
        Number(
          similarity.toFixed(4)
        )
    });
  }

  candidates.sort(
    (a, b) =>
      a.distance_m -
        b.distance_m ||
      b.name_similarity -
        a.name_similarity ||
      a.osm_id.localeCompare(
        b.osm_id
      )
  );

  results.push({
    objectid:
      spatialRow.objectid,

    official_name:
      spatialRow.official_name,

    candidates
  });

  if (
    (index + 1) % 250 === 0 ||
    index + 1 ===
      zeroContainment.length
  ) {
    console.log(
      `Processed ${index + 1}/${zeroContainment.length}`
    );
  }
}

function hasWithin(
  row,
  meters
) {
  return row.candidates.some(
    candidate =>
      candidate.distance_m <=
      meters
  );
}

const exactWithin150 =
  results.filter(
    row =>
      row.candidates.some(
        candidate =>
          candidate.distance_m <= 150 &&
          candidate.exact_name
      )
  ).length;

const strongWithin150 =
  results.filter(
    row =>
      row.candidates.some(
        candidate =>
          candidate.distance_m <= 150 &&
          candidate.name_similarity >= 0.75
      )
  ).length;

const summary = {
  officialZeroContainment:
    results.length,

  nearestOsmWithin25m:
    results.filter(
      row => hasWithin(row, 25)
    ).length,

  nearestOsmWithin50m:
    results.filter(
      row => hasWithin(row, 50)
    ).length,

  nearestOsmWithin100m:
    results.filter(
      row => hasWithin(row, 100)
    ).length,

  nearestOsmWithin150m:
    results.filter(
      row => hasWithin(row, 150)
    ).length,

  nearestOsmWithin300m:
    results.filter(
      row => hasWithin(row, 300)
    ).length,

  exactNameCandidateWithin150m:
    exactWithin150,

  strongNameCandidateWithin150m:
    strongWithin150,

  noOsmWithin300m:
    results.filter(
      row =>
        row.candidates.length === 0
    ).length
};

await writeFile(
  outputPath,
  JSON.stringify(
    results,
    null,
    2
  )
);

console.log(
  "\n===== İZMİR PROXIMITY AUDIT ====="
);

console.log(summary);

console.log(
  `\nSaved -> ${String(outputPath)}`
);

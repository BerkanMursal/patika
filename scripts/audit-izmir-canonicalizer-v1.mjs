import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "./park-enrichment.mjs";

const officialPath =
  new URL(
    "../data/park-enrichment/.cache/izmir-official-parks.json",
    import.meta.url
  );

const spatialPath =
  new URL(
    "../data/park-enrichment/.cache/izmir-spatial-audit.json",
    import.meta.url
  );

const proximityPath =
  new URL(
    "../data/park-enrichment/.cache/izmir-proximity-audit.json",
    import.meta.url
  );

const outputPath =
  new URL(
    "../data/park-enrichment/.cache/izmir-canonicalizer-v1-audit.json",
    import.meta.url
  );

const official = JSON.parse(
  await readFile(officialPath, "utf8")
);

const spatial = JSON.parse(
  await readFile(spatialPath, "utf8")
);

const proximity = JSON.parse(
  await readFile(proximityPath, "utf8")
);

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function genericName(value) {
  const key = nameKey(value);

  return !key || new Set([
    "park",
    "cocukparki",
    "dinlenmevecocukparki",
    "cocukvedinlenmeparki",
    "yesilalan",
    "isimsizpark",
    "cocukbahcesi"
  ]).has(key);
}

const officialById = new Map(
  official.features.map(feature => [
    feature.attributes.OBJECTID,
    {
      objectid:
        feature.attributes.OBJECTID,

      name:
        clean(feature.attributes.ADI) ||
        null,

      area_m2:
        Number(
          feature.attributes.SHAPE_Area
        ) || 0,

      rings:
        feature.geometry?.rings ?? []
    }
  ])
);

const spatialById = new Map(
  spatial.official.map(row => [
    row.objectid,
    row
  ])
);

const proximityById = new Map(
  proximity.map(row => [
    row.objectid,
    row
  ])
);

/* -----------------------------------------
   Geometry
----------------------------------------- */

function pointInRing(lon, lat, ring) {
  let inside = false;

  for (
    let i = 0, j = ring.length - 1;
    i < ring.length;
    j = i++
  ) {
    const a = ring[i];
    const b = ring[j];

    if (
      (a[1] > lat) !== (b[1] > lat) &&
      lon <
        ((b[0] - a[0]) *
          (lat - a[1])) /
          (b[1] - a[1]) +
          a[0]
    ) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInPolygon(
  lon,
  lat,
  rings
) {
  let hits = 0;

  for (const ring of rings ?? []) {
    if (
      pointInRing(
        lon,
        lat,
        ring
      )
    ) {
      hits++;
    }
  }

  return hits % 2 === 1;
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
  lon,
  lat,
  a,
  b
) {
  const lat0 =
    (lat + a[1] + b[1]) / 3;

  const mx =
    metersPerLon(lat0);

  const my = 110540;

  const px = lon * mx;
  const py = lat * my;

  const ax = a[0] * mx;
  const ay = a[1] * my;

  const bx = b[0] * mx;
  const by = b[1] * my;

  const abx = bx - ax;
  const aby = by - ay;

  const apx = px - ax;
  const apy = py - ay;

  const denom =
    abx * abx +
    aby * aby;

  let t =
    denom === 0
      ? 0
      : (
          apx * abx +
          apy * aby
        ) / denom;

  t = Math.max(
    0,
    Math.min(1, t)
  );

  return Math.hypot(
    px - (ax + t * abx),
    py - (ay + t * aby)
  );
}

function pointToRingsDistance(
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
      best = Math.min(
        best,
        pointSegmentDistanceMeters(
          lon,
          lat,
          ring[i],
          ring[i + 1]
        )
      );
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
      best = Math.min(
        best,
        pointSegmentDistanceMeters(
          lon,
          lat,
          ring[ring.length - 1],
          ring[0]
        )
      );
    }
  }

  return best;
}

function polygonDistanceMeters(
  ringsA,
  ringsB
) {
  const pointsA =
    (ringsA ?? []).flat();

  const pointsB =
    (ringsB ?? []).flat();

  if (
    !pointsA.length ||
    !pointsB.length
  ) {
    return Infinity;
  }

  for (const [lon, lat] of pointsA) {
    if (
      pointInPolygon(
        lon,
        lat,
        ringsB
      )
    ) {
      return 0;
    }
  }

  for (const [lon, lat] of pointsB) {
    if (
      pointInPolygon(
        lon,
        lat,
        ringsA
      )
    ) {
      return 0;
    }
  }

  let best = Infinity;

  for (const [lon, lat] of pointsA) {
    best = Math.min(
      best,
      pointToRingsDistance(
        lon,
        lat,
        ringsB
      )
    );
  }

  for (const [lon, lat] of pointsB) {
    best = Math.min(
      best,
      pointToRingsDistance(
        lon,
        lat,
        ringsA
      )
    );
  }

  return best;
}

/* -----------------------------------------
   Specific-name spatial clusters
----------------------------------------- */

const specificGroups =
  new Map();

for (
  const park
  of officialById.values()
) {
  if (
    !park.name ||
    genericName(park.name)
  ) {
    continue;
  }

  const key =
    nameKey(park.name);

  if (!specificGroups.has(key))
    specificGroups.set(key, []);

  specificGroups
    .get(key)
    .push(park);
}

const specificClusters = [];

for (
  const [normalizedName, parks]
  of specificGroups
) {
  const parent =
    parks.map((_, i) => i);

  function find(i) {
    while (parent[i] !== i) {
      parent[i] =
        parent[parent[i]];

      i = parent[i];
    }

    return i;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);

    if (ra !== rb)
      parent[rb] = ra;
  }

  for (
    let i = 0;
    i < parks.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < parks.length;
      j++
    ) {
      const distance =
        polygonDistanceMeters(
          parks[i].rings,
          parks[j].rings
        );

      if (distance <= 25)
        union(i, j);
    }
  }

  const components =
    new Map();

  for (
    let i = 0;
    i < parks.length;
    i++
  ) {
    const root = find(i);

    if (!components.has(root))
      components.set(root, []);

    components
      .get(root)
      .push(parks[i]);
  }

  for (
    const component
    of components.values()
  ) {
    component.sort(
      (a, b) =>
        a.objectid -
        b.objectid
    );

    specificClusters.push({
      normalized_name:
        normalizedName,

      official_name:
        component[0].name,

      objectids:
        component.map(
          park => park.objectid
        ),

      polygon_count:
        component.length,

      total_area_m2:
        component.reduce(
          (sum, park) =>
            sum + park.area_m2,
          0
        )
    });
  }
}

specificClusters.sort(
  (a, b) =>
    a.objectids[0] -
    b.objectids[0]
);

/* -----------------------------------------
   Polygon classification
----------------------------------------- */

const classifications = [];

for (
  const park
  of officialById.values()
) {
  const spatialRow =
    spatialById.get(
      park.objectid
    );

  if (!spatialRow) {
    throw new Error(
      `Spatial row missing: ${park.objectid}`
    );
  }

  const contained =
    spatialRow.contained_osm ?? [];

  if (contained.length === 1) {
    const osm = contained[0];

    classifications.push({
      objectid:
        park.objectid,

      official_name:
        park.name,

      class:
        "contained_single_osm",

      osm_id:
        osm.osm_id,

      osm_name:
        osm.osm_name,

      distance_m: 0
    });

    continue;
  }

  if (contained.length > 1) {
    classifications.push({
      objectid:
        park.objectid,

      official_name:
        park.name,

      class:
        "review_multiple_contained_osm",

      candidates:
        contained
    });

    continue;
  }

  const proximityRow =
    proximityById.get(
      park.objectid
    );

  const near30 =
    (proximityRow?.candidates ?? [])
      .filter(
        candidate =>
          candidate.distance_m <= 30
      );

  if (genericName(park.name)) {
    if (near30.length === 1) {
      const osm = near30[0];

      classifications.push({
        objectid:
          park.objectid,

        official_name:
          park.name,

        class:
          "generic_fragment_single_osm_30m",

        osm_id:
          osm.osm_id,

        osm_name:
          osm.osm_name,

        distance_m:
          osm.distance_m
      });

      continue;
    }

    if (near30.length > 1) {
      classifications.push({
        objectid:
          park.objectid,

        official_name:
          park.name,

        class:
          "review_generic_multiple_osm_30m",

        candidates:
          near30
      });

      continue;
    }

    classifications.push({
      objectid:
        park.objectid,

      official_name:
        park.name,

      class:
        "official_unanchored"
    });

    continue;
  }

  if (near30.length > 0) {
    classifications.push({
      objectid:
        park.objectid,

      official_name:
        park.name,

      class:
        "review_named_near_osm",

      candidates:
        near30
    });

    continue;
  }

  classifications.push({
    objectid:
      park.objectid,

    official_name:
      park.name,

    class:
      "official_unanchored"
  });
}

/* -----------------------------------------
   Safe-ish OSM anchor groups
----------------------------------------- */

const anchorGroups =
  new Map();

for (
  const row
  of classifications
) {
  if (
    row.class !==
      "contained_single_osm" &&
    row.class !==
      "generic_fragment_single_osm_30m"
  ) {
    continue;
  }

  if (!anchorGroups.has(row.osm_id)) {
    anchorGroups.set(
      row.osm_id,
      []
    );
  }

  anchorGroups
    .get(row.osm_id)
    .push(row);
}

const multiAnchors =
  [...anchorGroups.entries()]
    .filter(
      ([, rows]) =>
        rows.length > 1
    )
    .sort(
      (a, b) =>
        b[1].length -
        a[1].length
    );

const counts = {};

for (const row of classifications) {
  counts[row.class] =
    (counts[row.class] ?? 0) +
    1;
}

const summary = {
  officialRawPolygons:
    official.features.length,

  specificNameSpatialClusters:
    specificClusters.length,

  contained_single_osm:
    counts.contained_single_osm ?? 0,

  official_unanchored:
    counts.official_unanchored ?? 0,

  review_named_near_osm:
    counts.review_named_near_osm ?? 0,

  review_multiple_contained_osm:
    counts.review_multiple_contained_osm ?? 0,

  generic_fragment_single_osm_30m:
    counts.generic_fragment_single_osm_30m ?? 0,

  review_generic_multiple_osm_30m:
    counts.review_generic_multiple_osm_30m ?? 0,

  uniqueOsmAnchors:
    anchorGroups.size,

  osmAnchorsWithMultipleOfficialPolygons:
    multiAnchors.length,

  polygonsAttachedToThoseMultiAnchors:
    multiAnchors.reduce(
      (sum, [, rows]) =>
        sum + rows.length,
      0
    )
};

const output = {
  generatedAt:
    new Date().toISOString(),

  thresholdMeters: {
    sameSpecificNameCluster: 25,
    genericSingleOsmAnchor: 30
  },

  summary,

  specificClusters,

  classifications,

  osmAnchors:
    [...anchorGroups.entries()]
      .map(([osm_id, rows]) => ({
        osm_id,
        polygons:
          rows.map(row => ({
            objectid:
              row.objectid,

            official_name:
              row.official_name,

            class:
              row.class,

            distance_m:
              row.distance_m
          }))
      }))
};

await writeFile(
  outputPath,
  JSON.stringify(
    output,
    null,
    2
  )
);

console.log(
  "===== CANONICALIZER V1 AUDIT ====="
);

console.log(summary);

console.log(
  "\n===== TOP MULTI-POLYGON OSM ANCHORS ====="
);

for (
  const [osmId, rows]
  of multiAnchors.slice(0, 10)
) {
  console.log({
    osm_id: osmId,
    official_polygons:
      rows.length
  });
}

console.log(
  `\nSaved -> ${String(outputPath)}`
);

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "./park-enrichment.mjs";

const officialPath =
  process.env.IZMIR_OFFICIAL_SNAPSHOT ||
  new URL("../data/park-enrichment/.cache/izmir-official-parks.json", import.meta.url);

const previewPath =
  process.env.IZMIR_CANONICAL_PREVIEW ||
  new URL("../data/park-enrichment/.cache/izmir-canonical-preview.json", import.meta.url);

const proximityPath =
  process.env.IZMIR_PROXIMITY_AUDIT ||
  new URL("../data/park-enrichment/.cache/izmir-proximity-audit.json", import.meta.url);

const outputPath =
  process.env.IZMIR_CANONICAL_V2_OUTPUT ||
  new URL("../data/park-enrichment/.cache/izmir-canonical-v2.json", import.meta.url);

const official = JSON.parse(
  await readFile(officialPath, "utf8")
);

const preview = JSON.parse(
  await readFile(previewPath, "utf8")
);

const proximity = JSON.parse(
  await readFile(proximityPath, "utf8")
);

const districts = JSON.parse(
  await readFile(
    new URL(
      "../data/park-enrichment/districts.geojson",
      import.meta.url
    ),
    "utf8"
  )
);

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

function inRing(lon, lat, ring) {
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
        ((b[0] - a[0]) * (lat - a[1])) /
          (b[1] - a[1]) +
          a[0]
    ) {
      inside = !inside;
    }
  }

  return inside;
}

function inArcPolygon(lon, lat, rings) {
  let hits = 0;

  for (const ring of rings ?? []) {
    if (inRing(lon, lat, ring)) hits++;
  }

  return hits % 2 === 1;
}

function ringCentroid(ring) {
  let area2 = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];

    const cross = x1 * y2 - x2 * y1;

    area2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }

  if (Math.abs(area2) < 1e-15)
    return null;

  return {
    lon: cx / (3 * area2),
    lat: cy / (3 * area2)
  };
}

function pointOnSurface(rings) {
  const points = (rings ?? []).flat();

  if (!points.length)
    throw new Error("Polygon has no coordinates.");

  const minLon = Math.min(...points.map(p => p[0]));
  const maxLon = Math.max(...points.map(p => p[0]));
  const minLat = Math.min(...points.map(p => p[1]));
  const maxLat = Math.max(...points.map(p => p[1]));

  for (const ring of rings ?? []) {
    const centroid = ringCentroid(ring);

    if (
      centroid &&
      inArcPolygon(
        centroid.lon,
        centroid.lat,
        rings
      )
    ) {
      return centroid;
    }
  }

  const boxCenter = {
    lon: (minLon + maxLon) / 2,
    lat: (minLat + maxLat) / 2
  };

  if (
    inArcPolygon(
      boxCenter.lon,
      boxCenter.lat,
      rings
    )
  ) {
    return boxCenter;
  }

  let best = null;

  for (let step = 1; step < 80; step++) {
    const lat =
      minLat +
      (maxLat - minLat) *
        (step / 80);

    const intersections = [];

    for (const ring of rings ?? []) {
      for (
        let i = 0, j = ring.length - 1;
        i < ring.length;
        j = i++
      ) {
        const a = ring[j];
        const b = ring[i];

        if (
          (a[1] > lat) ===
          (b[1] > lat)
        ) {
          continue;
        }

        const lon =
          a[0] +
          ((lat - a[1]) *
            (b[0] - a[0])) /
            (b[1] - a[1]);

        intersections.push(lon);
      }
    }

    intersections.sort(
      (a, b) => a - b
    );

    for (
      let i = 0;
      i + 1 < intersections.length;
      i += 2
    ) {
      const left = intersections[i];
      const right = intersections[i + 1];
      const width = right - left;
      const lon = (left + right) / 2;

      if (
        width > 0 &&
        inArcPolygon(
          lon,
          lat,
          rings
        ) &&
        (!best || width > best.width)
      ) {
        best = {
          lon,
          lat,
          width
        };
      }
    }
  }

  if (best) {
    return {
      lon: best.lon,
      lat: best.lat
    };
  }

  throw new Error(
    "Could not find point on polygon surface."
  );
}

function pointInGeoPolygon(
  lon,
  lat,
  coordinates
) {
  const outer = coordinates?.[0];

  if (
    !outer ||
    !inRing(lon, lat, outer)
  ) {
    return false;
  }

  for (
    let i = 1;
    i < coordinates.length;
    i++
  ) {
    if (
      inRing(
        lon,
        lat,
        coordinates[i]
      )
    ) {
      return false;
    }
  }

  return true;
}

function pointInGeoGeometry(
  lon,
  lat,
  geometry
) {
  if (!geometry)
    return false;

  if (
    geometry.type === "Polygon"
  ) {
    return pointInGeoPolygon(
      lon,
      lat,
      geometry.coordinates
    );
  }

  if (
    geometry.type === "MultiPolygon"
  ) {
    return geometry.coordinates.some(
      polygon =>
        pointInGeoPolygon(
          lon,
          lat,
          polygon
        )
    );
  }

  return false;
}

function districtFor(lat, lon) {
  for (
    const feature
    of districts.features ?? []
  ) {
    if (
      pointInGeoGeometry(
        lon,
        lat,
        feature.geometry
      )
    ) {
      return String(
        feature.properties?.shapeName ??
        feature.properties?.name ??
        ""
      ).trim();
    }
  }

  return "";
}

const officialById = new Map(
  official.features.map(feature => [
    feature.attributes.OBJECTID,
    feature
  ])
);

const proximityById = new Map(
  proximity.map(row => [
    row.objectid,
    row
  ])
);

const osmCanonical =
  structuredClone(
    preview.osmCanonical
  ).map(park => {
    const id =
      park.id ??
      park.canonical_id;

    if (!id) {
      throw new Error(
        `OSM canonical missing id: ${park.osm_id}`
      );
    }

    return {
      ...park,
      id
    };
  });

const osmById = new Map(
  osmCanonical.map(row => [
    row.osm_id,
    row
  ])
);

const remainingOfficialOnly = [];
const rescuedOfficialOnly = [];

for (
  const candidate
  of preview.officialOnly
) {
  const strong = new Map();

  for (
    const objectid
    of candidate.objectids
  ) {
    const row =
      proximityById.get(objectid);

    for (
      const osm
      of row?.candidates ?? []
    ) {
      if (
        osm.distance_m <= 150 &&
        osm.exact_name
      ) {
        const old =
          strong.get(osm.osm_id);

        if (
          !old ||
          osm.distance_m <
            old.distance_m
        ) {
          strong.set(
            osm.osm_id,
            {
              ...osm,
              objectid
            }
          );
        }
      }
    }
  }

  if (strong.size !== 1) {
    remainingOfficialOnly.push(
      candidate
    );

    continue;
  }

  const [match] =
    [...strong.values()];

  const canonical =
    osmById.get(match.osm_id);

  if (!canonical) {
    throw new Error(
      `Missing OSM canonical ${match.osm_id}`
    );
  }

  for (
    const objectid
    of candidate.objectids
  ) {
    if (
      !canonical.official_objectids
        .includes(objectid)
    ) {
      canonical.official_objectids
        .push(objectid);
    }

    canonical.source_refs.push({
      source_code:
        "izmir_kent_rehberi",

      external_id:
        String(objectid),

      source_url:
        "https://kentrehberi.izmir.bel.tr/izmirkentrehberi"
    });
  }

  if (
    candidate.official_name &&
    !canonical.official_names
      .includes(
        candidate.official_name
      )
  ) {
    canonical.official_names.push(
      candidate.official_name
    );
  }

  rescuedOfficialOnly.push({
    official_name:
      candidate.official_name,

    objectids:
      candidate.objectids,

    osm_id:
      match.osm_id,

    osm_name:
      match.osm_name,

    distance_m:
      match.distance_m
  });
}

const safeNameUpgrades = [];

for (const park of osmCanonical) {
  const osmMissing =
    !park.name ||
    nameKey(park.name) ===
      nameKey("İsimsiz park");

  if (!osmMissing)
    continue;

  const names =
    [...new Set(
      (park.official_names ?? [])
        .filter(
          name =>
            name &&
            !genericName(name)
        )
    )];

  if (names.length !== 1)
    continue;

  const oldName =
    park.name;

  park.name =
    names[0];

  park.name_status =
    "municipal";

  park.name_source =
    "İzmir Büyükşehir Belediyesi Kent Rehberi";

  park.name_source_url =
    "https://kentrehberi.izmir.bel.tr/izmirkentrehberi";

  safeNameUpgrades.push({
    osm_id:
      park.osm_id,

    old_name:
      oldName,

    new_name:
      park.name,

    objectids:
      park.official_objectids
  });
}

const municipalCanonical = [];

for (
  const candidate
  of remainingOfficialOnly
) {
  const features =
    candidate.objectids.map(id => {
      const feature =
        officialById.get(id);

      if (!feature)
        throw new Error(
          `Official feature missing: ${id}`
        );

      return feature;
    });

  const representative =
    [...features].sort(
      (a, b) =>
        Number(
          b.attributes.SHAPE_Area
        ) -
        Number(
          a.attributes.SHAPE_Area
        )
    )[0];

  const point =
    pointOnSurface(
      representative.geometry?.rings ?? []
    );

  const district =
    districtFor(
      point.lat,
      point.lon
    );

  const sortedObjectIds =
    [...candidate.objectids]
      .sort((a, b) => a - b);

  const bootstrapKey =
    `patika-izmir-kent-rehberi:${sortedObjectIds[0]}`;

  municipalCanonical.push({
    id:
      deterministicUuid(
        bootstrapKey
      ),

    osm_id:
      null,

    name:
      candidate.official_name,

    city:
      "İzmir",

    district,

    latitude:
      Number(
        point.lat.toFixed(7)
      ),

    longitude:
      Number(
        point.lon.toFixed(7)
      ),

    source:
      "İzmir Büyükşehir Belediyesi Kent Rehberi",

    name_status:
      "municipal",

    name_source:
      "İzmir Büyükşehir Belediyesi Kent Rehberi",

    name_source_url:
      "https://kentrehberi.izmir.bel.tr/izmirkentrehberi",

    address_label:
      "",

    official_objectids:
      sortedObjectIds,

    source_refs:
      sortedObjectIds.map(
        objectid => ({
          source_code:
            "izmir_kent_rehberi",

          external_id:
            String(objectid),

          source_url:
            "https://kentrehberi.izmir.bel.tr/izmirkentrehberi"
        })
      )
  });
}

for (const park of osmCanonical) {
  park.source_refs =
    [...new Map(
      (park.source_refs ?? [])
        .map(ref => [
          `${ref.source_code}:${ref.external_id}`,
          ref
        ])
    ).values()];

  park.official_objectids =
    [...new Set(
      park.official_objectids ?? []
    )].sort(
      (a, b) => a - b
    );

  park.official_names =
    [...new Set(
      park.official_names ?? []
    )];
}

const allCanonical = [
  ...osmCanonical,
  ...municipalCanonical
];

const ids = new Set();
const refs = new Map();

for (const park of allCanonical) {
  if (ids.has(park.id))
    throw new Error(
      `Duplicate canonical id ${park.id}`
    );

  ids.add(park.id);

  for (
    const ref
    of park.source_refs ?? []
  ) {
    const key =
      `${ref.source_code}:${ref.external_id}`;

    if (refs.has(key)) {
      throw new Error(
        `Duplicate source ref ${key}: ${refs.get(key)} and ${park.id}`
      );
    }

    refs.set(
      key,
      park.id
    );
  }
}

const missingDistrict =
  municipalCanonical.filter(
    park => !park.district
  );

const officialRefsAttachedToOsm =
  osmCanonical.reduce(
    (sum, park) =>
      sum +
      (
        park.source_refs ?? []
      ).filter(
        ref =>
          ref.source_code ===
          "izmir_kent_rehberi"
      ).length,
    0
  );

const summary = {
  osmCanonicalParks:
    osmCanonical.length,

  rescuedOfficialOnlyIntoOsm:
    rescuedOfficialOnly.length,

  municipalOnlyCanonicalParks:
    municipalCanonical.length,

  totalCanonicalParks:
    allCanonical.length,

  officialRefsAttachedToOsm,

  safeMunicipalNameUpgrades:
    safeNameUpgrades.length,

  unresolvedGenericOrBlankPolygons:
    preview.unresolved.length,

  reviewItems:
    preview.review.length,

  municipalParksMissingDistrict:
    missingDistrict.length,

  duplicateCanonicalIds:
    0,

  duplicateSourceRefs:
    0
};

const output = {
  generatedAt:
    new Date().toISOString(),

  mode:
    "canonical-v2-preview",

  sourceSnapshot:
    officialPath,

  summary,

  rescuedOfficialOnly,

  safeNameUpgrades,

  parks:
    allCanonical,

  unresolved:
    preview.unresolved,

  review:
    preview.review
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
  "===== İZMİR CANONICAL V2 ====="
);

console.log(summary);

console.log(
  "\n===== RESCUED OFFICIAL-ONLY ====="
);

console.dir(
  rescuedOfficialOnly,
  { depth: null }
);

console.log(
  "\n===== MUNICIPAL-ONLY FIRST 20 ====="
);

console.dir(
  municipalCanonical
    .slice(0, 20)
    .map(park => ({
      id:
        park.id,

      name:
        park.name,

      district:
        park.district,

      latitude:
        park.latitude,

      longitude:
        park.longitude,

      objectids:
        park.official_objectids
    })),
  { depth: null }
);

if (missingDistrict.length) {
  console.log(
    "\n===== MISSING DISTRICTS ====="
  );

  console.dir(
    missingDistrict.map(
      park => ({
        name:
          park.name,

        latitude:
          park.latitude,

        longitude:
          park.longitude,

        objectids:
          park.official_objectids
      })
    ),
    { depth: null }
  );
}

console.log(
  `\nSaved -> ${outputPath}`
);

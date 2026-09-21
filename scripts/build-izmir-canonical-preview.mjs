import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "./park-enrichment.mjs";

const officialPath =
  process.env.IZMIR_OFFICIAL_SNAPSHOT ||
  new URL("../data/park-enrichment/.cache/izmir-official-parks.json", import.meta.url);

const auditPath =
  process.env.IZMIR_CANONICAL_AUDIT ||
  new URL("../data/park-enrichment/.cache/izmir-canonicalizer-v1-audit.json", import.meta.url);

const outputPath =
  process.env.IZMIR_CANONICAL_OUTPUT ||
  new URL("../data/park-enrichment/.cache/izmir-canonical-preview.json", import.meta.url);

const official = JSON.parse(
  await readFile(officialPath, "utf8")
);

const audit = JSON.parse(
  await readFile(auditPath, "utf8")
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

const osmParks = catalog
  .filter(row => row[3] === "İzmir")
  .map(row => ({
    id: row[0],
    osm_id: row[1],
    name: row[2],
    city: row[3],
    district: row[4],
    latitude: row[5],
    longitude: row[6]
  }));

const officialById = new Map(
  official.features.map(feature => [
    feature.attributes.OBJECTID,
    {
      objectid: feature.attributes.OBJECTID,
      name:
        String(feature.attributes.ADI ?? "")
          .replace(/\s+/g, " ")
          .trim() || null,
      area_m2:
        Number(feature.attributes.SHAPE_Area) || 0
    }
  ])
);

const classificationById = new Map(
  audit.classifications.map(row => [
    row.objectid,
    row
  ])
);

const specificObjectIds = new Set(
  audit.specificClusters.flatMap(
    cluster => cluster.objectids
  )
);

const AUTO_CLASSES = new Set([
  "contained_single_osm",
  "generic_fragment_single_osm_30m"
]);

const REVIEW_CLASSES = new Set([
  "review_multiple_contained_osm",
  "review_generic_multiple_osm_30m",
  "review_named_near_osm"
]);

/* -------------------------------------------------
   OSM canonical entities
------------------------------------------------- */

const canonicalByOsm = new Map(
  osmParks.map(park => [
    park.osm_id,
    {
      canonical_id: park.id,
      kind: "osm",
      name: park.name,
      city: park.city,
      district: park.district,
      latitude: park.latitude,
      longitude: park.longitude,
      osm_id: park.osm_id,

      source_refs: [
        {
          source_code: "osm",
          external_id: park.osm_id,
          source_url:
            `https://www.openstreetmap.org/${park.osm_id}`
        }
      ],

      official_objectids: [],
      official_names: []
    }
  ])
);

function attachOfficial(osmId, objectid) {
  const canonical = canonicalByOsm.get(osmId);

  if (!canonical)
    throw new Error(
      `OSM anchor missing from İzmir catalog: ${osmId}`
    );

  const officialPark = officialById.get(objectid);

  canonical.official_objectids.push(objectid);

  if (
    officialPark?.name &&
    !canonical.official_names.includes(
      officialPark.name
    )
  ) {
    canonical.official_names.push(
      officialPark.name
    );
  }

  canonical.source_refs.push({
    source_code: "izmir_kent_rehberi",
    external_id: String(objectid),
    source_url:
      "https://kentrehberi.izmir.bel.tr/izmirkentrehberi"
  });
}

/* -------------------------------------------------
   Specific-name clusters
------------------------------------------------- */

const officialOnly = [];
const review = [];
const claimedSpecificIds = new Set();

for (const cluster of audit.specificClusters) {
  const rows = cluster.objectids.map(id => {
    const classification =
      classificationById.get(id);

    return {
      park: officialById.get(id),
      classification
    };
  });

  const strongAnchors = new Set();

  let hasReview = false;

  for (const { classification } of rows) {
    if (!classification)
      continue;

    if (
      AUTO_CLASSES.has(classification.class) &&
      classification.osm_id
    ) {
      strongAnchors.add(
        classification.osm_id
      );
    }

    if (
      REVIEW_CLASSES.has(
        classification.class
      )
    ) {
      hasReview = true;
    }
  }

  for (const id of cluster.objectids)
    claimedSpecificIds.add(id);

  if (
    strongAnchors.size === 1 &&
    !hasReview
  ) {
    const osmId =
      [...strongAnchors][0];

    for (const id of cluster.objectids)
      attachOfficial(osmId, id);

    continue;
  }

  if (
    strongAnchors.size > 1 ||
    hasReview
  ) {
    review.push({
      reason:
        strongAnchors.size > 1
          ? "specific_cluster_multiple_osm_anchors"
          : "specific_cluster_requires_review",

      official_name:
        cluster.official_name,

      objectids:
        [...cluster.objectids],

      osm_anchors:
        [...strongAnchors]
    });

    continue;
  }

  officialOnly.push({
    kind: "official_only",
    official_name:
      cluster.official_name,

    objectids:
      [...cluster.objectids],

    polygon_count:
      cluster.polygon_count,

    total_area_m2:
      cluster.total_area_m2,

    source_refs:
      cluster.objectids.map(id => ({
        source_code:
          "izmir_kent_rehberi",

        external_id:
          String(id),

        source_url:
          "https://kentrehberi.izmir.bel.tr/izmirkentrehberi"
      })),

    coordinate_status:
      "pending_point_on_surface"
  });
}

/* -------------------------------------------------
   Blank / generic official polygons
------------------------------------------------- */

const unresolved = [];

for (const classification of audit.classifications) {
  if (
    claimedSpecificIds.has(
      classification.objectid
    )
  ) {
    continue;
  }

  if (
    AUTO_CLASSES.has(
      classification.class
    ) &&
    classification.osm_id
  ) {
    attachOfficial(
      classification.osm_id,
      classification.objectid
    );

    continue;
  }

  if (
    REVIEW_CLASSES.has(
      classification.class
    )
  ) {
    review.push({
      reason:
        classification.class,

      objectid:
        classification.objectid,

      official_name:
        classification.official_name ??
        null,

      candidates:
        classification.candidates ?? []
    });

    continue;
  }

  unresolved.push({
    objectid:
      classification.objectid,

    official_name:
      classification.official_name ??
      null,

    reason:
      "generic_or_blank_without_safe_anchor"
  });
}

/* -------------------------------------------------
   Name upgrade candidates
------------------------------------------------- */

const nameUpgrades = [];

for (const canonical of canonicalByOsm.values()) {
  const osmMissing =
    nameKey(canonical.name) ===
      nameKey("İsimsiz park") ||
    !canonical.name;

  const specificNames =
    [...new Set(
      canonical.official_names.filter(Boolean)
    )];

  if (
    osmMissing &&
    specificNames.length === 1
  ) {
    nameUpgrades.push({
      osm_id:
        canonical.osm_id,

      current_name:
        canonical.name,

      proposed_name:
        specificNames[0],

      evidence_objectids:
        canonical.official_objectids
    });
  }
}

/* -------------------------------------------------
   Summary
------------------------------------------------- */

const osmCanonical =
  [...canonicalByOsm.values()];

const osmWithOfficialEvidence =
  osmCanonical.filter(
    row =>
      row.official_objectids.length > 0
  );

const officialRefsAttachedToOsm =
  osmCanonical.reduce(
    (sum, row) =>
      sum +
      row.official_objectids.length,
    0
  );

const summary = {
  osmCanonicalParks:
    osmCanonical.length,

  osmCanonicalWithOfficialEvidence:
    osmWithOfficialEvidence.length,

  officialPolygonRefsAttachedToOsm:
    officialRefsAttachedToOsm,

  officialOnlyNamedCandidates:
    officialOnly.length,

  reviewItems:
    review.length,

  unresolvedGenericOrBlankPolygons:
    unresolved.length,

  safeOfficialNameUpgradeCandidates:
    nameUpgrades.length
};

const output = {
  generatedAt:
    new Date().toISOString(),

  mode:
    "preview",

  sourceSnapshot:
    officialPath,

  summary,

  osmCanonical,

  officialOnly,

  nameUpgrades,

  review,

  unresolved
};

await writeFile(
  outputPath,
  JSON.stringify(output, null, 2)
);

console.log(
  "===== CANONICAL İZMİR PREVIEW ====="
);

console.log(summary);

console.log(
  "\n===== NAME UPGRADES — FIRST 25 ====="
);

console.dir(
  nameUpgrades.slice(0, 25),
  { depth: null }
);

console.log(
  "\n===== OFFICIAL-ONLY NAMED — FIRST 25 ====="
);

console.dir(
  officialOnly.slice(0, 25).map(row => ({
    name:
      row.official_name,

    polygons:
      row.polygon_count,

    area_m2:
      Math.round(row.total_area_m2),

    objectids:
      row.objectids
  })),
  { depth: null }
);

console.log(
  `\nSaved -> ${outputPath}`
);

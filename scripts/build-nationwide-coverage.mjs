import { readFile, writeFile } from "node:fs/promises";

const provincesPath = new URL(
  "../data/provinces.geojson",
  import.meta.url
);

const rawOsmPath = new URL(
  "../data/parks-turkey.json",
  import.meta.url
);

const previewPath =
  process.env.NATIONWIDE_CANONICAL_PREVIEW ||
  new URL(
    "../data/park-enrichment/.cache/nationwide-canonical-preview.json",
    import.meta.url
  );

const izmirOfficialPath =
  process.env.IZMIR_OFFICIAL_SNAPSHOT ||
  new URL(
    "../data/park-enrichment/.cache/izmir-official-parks.json",
    import.meta.url
  );

const izmirV2Path =
  process.env.IZMIR_CANONICAL_V2 ||
  new URL(
    "../data/park-enrichment/.cache/izmir-canonical-v2.json",
    import.meta.url
  );

const outputPath =
  process.env.NATIONWIDE_COVERAGE_OUTPUT ||
  new URL(
    "../data/park-enrichment/.cache/nationwide-coverage-report.json",
    import.meta.url
  );

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const provinceBoundaries = JSON.parse(
  await readFile(provincesPath, "utf8")
);

const provinces = provinceBoundaries.features
  .map(f => f.properties.shapeName)
  .sort((a, b) => a.localeCompare(b, "tr"));

const legacyRawOsm = JSON.parse(
  await readFile(rawOsmPath, "utf8")
);

const preview = await readJsonIfExists(previewPath);

// The canonical preview records which OSM source it was actually built
// from (PBF snapshot vs. the legacy Overpass catalog) — reflect that here
// instead of always assuming the legacy catalog's fetchedAt.
const osmRefreshedAt =
  preview?.pbfSource?.fetchedAt ?? legacyRawOsm.fetchedAt ?? null;
const izmirOfficial = await readJsonIfExists(izmirOfficialPath);
const izmirV2 = await readJsonIfExists(izmirV2Path);

if (preview && preview.mode !== "nationwide-canonical-preview") {
  throw new Error(`Unexpected dataset mode: ${preview.mode}`);
}

const canonicalByProvince = new Map();

if (preview) {
  for (const park of preview.parks) {
    const key = park.city || "(atanmamış)";
    if (!canonicalByProvince.has(key)) {
      canonicalByProvince.set(key, []);
    }
    canonicalByProvince.get(key).push(park);
  }
}

const osmCountsByProvince = new Map();

if (preview) {
  for (const park of preview.parks) {
    if (!park.osm_id) continue;
    const key = park.city || "(atanmamış)";
    osmCountsByProvince.set(
      key,
      (osmCountsByProvince.get(key) ?? 0) + 1
    );
  }
}

const izmirReviewCount = izmirV2?.review?.length ?? null;
const izmirUnresolvedCount = izmirV2?.unresolved?.length ?? null;

const rows = provinces.map(province => {
  const canonicalParks = canonicalByProvince.get(province) ?? [];
  const isIzmir = province === "İzmir";

  const officialSourcesIntegrated = isIzmir && izmirV2
    ? ["izmir_kent_rehberi"]
    : [];

  const officialSourceRefs = canonicalParks.reduce(
    (sum, park) =>
      sum +
      (park.source_refs ?? []).filter(
        ref => ref.source_code !== "osm"
      ).length,
    0
  );

  return {
    province,
    osm_park_count: osmCountsByProvince.get(province) ?? 0,
    official_sources_integrated: officialSourcesIntegrated,
    official_raw_feature_count:
      isIzmir && izmirOfficial ? izmirOfficial.features.length : null,
    official_source_refs: officialSourceRefs,
    canonical_park_count: canonicalParks.length,
    official_only_canonical_count: canonicalParks.filter(
      p => !p.osm_id
    ).length,
    review_count: isIzmir ? izmirReviewCount : 0,
    unresolved_count: isIzmir ? izmirUnresolvedCount : 0,
    last_source_refresh: {
      osm: osmRefreshedAt,
      municipal:
        isIzmir && izmirOfficial ? izmirOfficial.fetchedAt : null
    }
  };
});

const summary = {
  provincesTotal: rows.length,
  provincesWithCanonicalPreview: preview ? rows.filter(
    r => r.canonical_park_count > 0
  ).length : 0,
  provincesWithOfficialSourceIntegrated: rows.filter(
    r => r.official_sources_integrated.length > 0
  ).length,
  canonicalPreviewAvailable: Boolean(preview),
  totalCanonicalParks: preview
    ? preview.summary.totalCanonicalParks
    : null,
  osmSource: preview?.osmSource ?? null,
  osmRawSnapshotFetchedAt: osmRefreshedAt
};

const output = {
  generatedAt: new Date().toISOString(),
  summary,
  provinces: rows
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== NATIONWIDE COVERAGE REPORT =====");
console.log(summary);

console.log(
  "\n===== TOP 15 PROVINCES BY CANONICAL PARK COUNT ====="
);

console.log(
  [...rows]
    .sort((a, b) => b.canonical_park_count - a.canonical_park_count)
    .slice(0, 15)
    .map(r => ({
      province: r.province,
      osm: r.osm_park_count,
      canonical: r.canonical_park_count,
      official_only: r.official_only_canonical_count,
      sources: r.official_sources_integrated
    }))
);

console.log(
  "\n===== PROVINCES WITH ZERO CANONICAL PARKS ====="
);

console.log(
  rows.filter(r => r.canonical_park_count === 0).map(r => r.province)
);

console.log(`\nSaved -> ${outputPath}`);

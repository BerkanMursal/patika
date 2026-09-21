import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const layerUrl =
  "https://kentrehberi.izmir.bel.tr/arcgis/rest/services/Rehber/CbsRehberGeo/MapServer/263";

const queryUrl = `${layerUrl}/query`;

const output =
  process.env.IZMIR_OFFICIAL_SNAPSHOT ||
  path.join(
    root,
    "data/park-enrichment/.cache/izmir-official-parks.json"
  );

async function post(params) {
  const response = await fetch(queryUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "PatikaDataFoundation/1.0"
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    throw new Error(
      `ArcGIS HTTP ${response.status}: ${await response.text()}`
    );
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(
      `ArcGIS error: ${JSON.stringify(json.error)}`
    );
  }

  return json;
}

console.log("Fetching layer metadata...");

const metadataResponse = await fetch(
  `${layerUrl}?f=json`,
  {
    signal: AbortSignal.timeout(60000)
  }
);

if (!metadataResponse.ok) {
  throw new Error(
    `Layer metadata HTTP ${metadataResponse.status}`
  );
}

const metadata = await metadataResponse.json();

if (metadata.error) {
  throw new Error(
    `Layer metadata error: ${JSON.stringify(metadata.error)}`
  );
}

console.log("Fetching TIP=1 object IDs...");

const idsResult = await post({
  where: "TIP=1",
  returnIdsOnly: "true",
  f: "json"
});

const objectIds = [
  ...new Set(idsResult.objectIds ?? [])
].sort((a, b) => a - b);

if (!objectIds.length) {
  throw new Error("No TIP=1 park OBJECTIDs returned.");
}

console.log(`Expected features: ${objectIds.length}`);

const features = [];
const chunkSize = 250;

for (
  let i = 0;
  i < objectIds.length;
  i += chunkSize
) {
  const chunk = objectIds.slice(
    i,
    i + chunkSize
  );

  const result = await post({
    objectIds: chunk.join(","),
    outFields:
      "OBJECTID,ADI,TIP,SHAPE_Length,SHAPE_Area",
    returnGeometry: "true",
    outSR: "4326",
    f: "json"
  });

  features.push(
    ...(result.features ?? [])
  );

  console.log(
    `Fetched ${features.length}/${objectIds.length}`
  );
}

const receivedIds =
  features.map(
    feature =>
      feature.attributes?.OBJECTID
  );

const receivedSet =
  new Set(receivedIds);

const missing =
  objectIds.filter(
    id => !receivedSet.has(id)
  );

const duplicateCount =
  receivedIds.length -
  receivedSet.size;

if (
  missing.length ||
  duplicateCount ||
  features.length !== objectIds.length
) {
  throw new Error(
    `Snapshot validation failed: expected=${objectIds.length}, received=${features.length}, unique=${receivedSet.size}, missing=${missing.length}, duplicates=${duplicateCount}`
  );
}

const snapshot = {
  source:
    "İzmir Büyükşehir Belediyesi Kent Rehberi",
  layer:
    metadata.name || "RHB_YESILALAN",
  layerId: 263,
  sourceUrl: layerUrl,
  filter: "TIP=1",
  fetchedAt:
    new Date().toISOString(),
  spatialReference:
    "EPSG:4326",
  expected:
    objectIds.length,
  features
};

await mkdir(
  path.dirname(output),
  { recursive: true }
);

await writeFile(
  output,
  JSON.stringify(snapshot)
);

console.log("\n===== SNAPSHOT COMPLETE =====");
console.log({
  expected: objectIds.length,
  received: features.length,
  uniqueReceived: receivedSet.size,
  missing: missing.length,
  duplicates: duplicateCount,
  output
});

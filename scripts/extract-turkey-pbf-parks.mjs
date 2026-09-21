import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const cacheDir = path.join(
  root,
  "data/park-enrichment/.cache/geofabrik"
);

const configPath = path.join(root, "scripts/osm/park-osmconf.ini");
const manifestPath = path.join(cacheDir, "manifest.json");

const manifest = JSON.parse(
  await readFile(manifestPath, "utf8")
);

const pbfPath = manifest.cachePath;

// GDAL's OSM driver must actually be able to read the file — a clearer
// failure here than the generic "not recognized" error ogr2ogr gives.
try {
  await readFile(pbfPath);
} catch {
  throw new Error(
    `PBF not found at ${pbfPath}. Run scripts/download-turkey-pbf.mjs first.`
  );
}

const { stdout: versionOut } = await run("ogr2ogr", ["--version"]);
const gdalVersion = versionOut.trim();

async function extractLayer(layer) {
  const outputPath = path.join(cacheDir, `${layer}.geojson`);
  const tmpPath = path.join(cacheDir, `${layer}.geojson.tmp`);

  // A leftover temp file from a previous interrupted run must not confuse
  // ogr2ogr (or a stale read below) — always start from a clean slate.
  await rm(tmpPath, { force: true });

  const args = [
    "-f", "GeoJSON",
    tmpPath,
    pbfPath,
    layer,
    "-oo", `CONFIG_FILE=${configPath}`,
    "-where", "leisure='park'"
  ];

  console.log(`Running: ogr2ogr ${args.join(" ")}`);

  let geojson;

  try {
    await run("ogr2ogr", args, { maxBuffer: 1024 * 1024 * 64 });
    geojson = JSON.parse(await readFile(tmpPath, "utf8"));
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }

  // Rename only after a full, successfully-parsed extraction — the previous
  // final artifact (if any) is never touched until this succeeds, so a
  // second run of this script never has to overwrite an existing GeoJSON
  // in place (the GDAL GeoJSON driver's -overwrite path is what raised
  // "DeleteLayer() not supported by this dataset" on a re-run).
  await rename(tmpPath, outputPath);

  return { outputPath, count: geojson.features.length, args };
}

const points = await extractLayer("points");
const multipolygons = await extractLayer("multipolygons");

let wayCount = 0;
let relationCount = 0;

{
  const geojson = JSON.parse(
    await readFile(multipolygons.outputPath, "utf8")
  );

  for (const feature of geojson.features) {
    if (feature.properties.osm_way_id) wayCount++;
    else if (feature.properties.osm_id) relationCount++;
    else {
      throw new Error(
        "Multipolygon feature with neither osm_way_id nor osm_id."
      );
    }
  }
}

const extractionManifest = {
  ...manifest,
  gdalVersion,
  osmconfPath: configPath,
  filter: "leisure=park",
  extractedAt: new Date().toISOString(),
  counts: {
    nodePoints: points.count,
    wayPolygons: wayCount,
    relationPolygons: relationCount,
    total: points.count + wayCount + relationCount
  },
  commands: {
    points: `ogr2ogr ${points.args.join(" ")}`,
    multipolygons: `ogr2ogr ${multipolygons.args.join(" ")}`
  }
};

await writeFile(
  manifestPath,
  JSON.stringify(extractionManifest, null, 2) + "\n"
);

console.log("\n===== EXTRACTION COMPLETE =====");
console.log(extractionManifest.counts);
console.log(`\nManifest -> ${manifestPath}`);
console.log(`Points -> ${points.outputPath}`);
console.log(`Multipolygons -> ${multipolygons.outputPath}`);

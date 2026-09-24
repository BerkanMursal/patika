import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

// Generic ULASAV KML/SHP(zip) fetcher for configs in data/municipal-ingestion-configs.json.
//   node scripts/download-ulasav-source.mjs <source_code>
// Keeps the raw download, records the DETECTED source CRS, converts to GeoJSON
// with an explicit `-t_srs EPSG:4326` (never trusts raw projected coordinates),
// and writes manifest.json with reprojection provenance. No DB, no merge.

const sourceCode = process.argv[2];
if (!sourceCode) throw new Error("Usage: node scripts/download-ulasav-source.mjs <source_code>");

const { configs } = JSON.parse(await readFile(new URL("../data/municipal-ingestion-configs.json", import.meta.url), "utf8"));
const config = configs.find(c => c.source_code === sourceCode);
if (!config) throw new Error(`No config for ${sourceCode}`);
if (config.license_status !== "SAFE_OPEN") throw new Error(`${sourceCode}: license_status not SAFE_OPEN`);
if (!["kml", "shp_zip"].includes(config.format)) throw new Error(`Unsupported format ${config.format}`);

const dir = new URL(`../data/park-enrichment/.cache/${config.cache_dir}/`, import.meta.url);
await mkdir(dir, { recursive: true });

const res = await fetch(config.endpoint, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(120000) });
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const rawName = config.format === "kml" ? "raw.kml" : "raw.zip";
await writeFile(new URL(rawName, dir), buf);

let sourcePath = new URL(rawName, dir).pathname;
if (config.format === "shp_zip") {
  await execFileAsync("unzip", ["-o", "-q", sourcePath, "-d", new URL("unzipped/", dir).pathname]);
  const { stdout } = await execFileAsync("bash", ["-c", `find '${new URL("unzipped/", dir).pathname}' -iname '*.shp' | head -1`]);
  sourcePath = stdout.trim();
  if (!sourcePath) throw new Error("no .shp in zip");
}

const { stdout: info } = await execFileAsync("ogrinfo", ["-al", "-so", sourcePath], { maxBuffer: 1 << 26 });
const crsName = info.match(/(?:PROJCRS|GEOGCRS|PROJCS|GEOGCS)\["([^"]+)"/)?.[1] ?? null;
const layerCount = Number(info.match(/Feature Count:\s*(\d+)/)?.[1] ?? NaN);
const geomType = info.match(/Geometry:\s*(.+)/)?.[1]?.trim() ?? null;
if (!crsName) throw new Error("No CRS metadata detected — refusing to guess");

const out = new URL(config.raw_filename, dir).pathname;
// -t_srs is explicit even for WGS84 sources (no-op) so provenance is uniform.
await execFileAsync("ogr2ogr", ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-lco", "RFC7946=NO", out, sourcePath], { maxBuffer: 1 << 26 });

if (config.format === "shp_zip") {
  // Provenance artifact: the untransformed projected X/Y per feature, so the
  // reprojection can be independently re-verified later.
  const { rm } = await import("node:fs/promises");
  const csvDir = new URL("raw-projected-xy/", dir).pathname;
  await rm(csvDir, { recursive: true, force: true });
  await execFileAsync("ogr2ogr", ["-f", "CSV", csvDir, "-lco", "GEOMETRY=AS_XY", sourcePath], { maxBuffer: 1 << 26 });
}

// Some DBFs truncate free-text fields at a byte limit mid-UTF-8-character.
// Normalize to valid UTF-8 (U+FFFD replacement) and record how many occurred.
const converted = await readFile(out);
const decoded = converted.toString("utf8");
const replacementChars = (decoded.match(/\uFFFD/g) ?? []).length;
const invalidUtf8Bytes = Buffer.compare(Buffer.from(decoded, "utf8"), converted) !== 0;
await writeFile(out, decoded);
let nameFieldReplacementChars = 0;
{
  const g = JSON.parse(decoded);
  for (const f of g.features) {
    const v = f.properties?.[config.name_field];
    if (typeof v === "string" && v.includes("\uFFFD")) nameFieldReplacementChars++;
  }
}

const manifest = {
  source_code: sourceCode,
  fetched_at: new Date().toISOString(),
  endpoint: config.endpoint,
  raw_file: rawName,
  raw_sha256: createHash("sha256").update(buf).digest("hex"),
  raw_bytes: buf.length,
  detected_source_crs: crsName,
  ogr_layer_feature_count: layerCount,
  ogr_geometry_type: geomType,
  target_crs: "EPSG:4326",
  reprojection_method: "ogr2ogr (GDAL/PROJ) -t_srs EPSG:4326 from CRS detected via ogrinfo; no manual math",
  license_url: config.license_url,
  utf8_normalization: { invalid_utf8_in_converted_output: invalidUtf8Bytes, replacement_chars: replacementChars, features_with_replacement_in_name_field: nameFieldReplacementChars }
};
await writeFile(new URL("manifest.json", dir), JSON.stringify(manifest, null, 2));
console.log(manifest);

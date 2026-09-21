import { readFile, writeFile } from "node:fs/promises";
import { runIngestion } from "./municipal-ingestion-engine.mjs";

// CLI runner for the generic config-driven engine:
//   node scripts/run-municipal-adapter.mjs <source_code> [--output=<path>] [--nationwide=<path>]
//
// Reads the source's config from data/municipal-ingestion-configs.json,
// its already-cached raw GeoJSON from data/park-enrichment/.cache/<cache_dir>/,
// and writes a preview JSON in the exact shape
// scripts/merge-municipal-sources.mjs already consumes. Never merges by
// itself, never writes the DB.

const args = process.argv.slice(2);
const sourceCode = args.find(a => !a.startsWith("--"));

if (!sourceCode) {
  throw new Error("Usage: node scripts/run-municipal-adapter.mjs <source_code> [--output=<path>]");
}

function flag(name) {
  const prefix = `--${name}=`;
  const match = args.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const configsPath = new URL("../data/municipal-ingestion-configs.json", import.meta.url);
const { configs } = JSON.parse(await readFile(configsPath, "utf8"));
const config = configs.find(c => c.source_code === sourceCode);

if (!config) {
  throw new Error(`No ingestion config found for source_code '${sourceCode}' in ${configsPath}`);
}

if (!config.enabled) {
  throw new Error(`Config for '${sourceCode}' has enabled:false — refusing to run.`);
}

const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const cacheDirUrl = new URL(`${config.cache_dir}/`, cacheRoot);

const nationwidePreviewPath = flag("nationwide")
  ? new URL(flag("nationwide"), `file://${process.cwd()}/`)
  : new URL("nationwide-canonical-preview.json", cacheRoot);

const nationwidePreview = JSON.parse(await readFile(nationwidePreviewPath, "utf8"));

const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const districtsPath = new URL("../data/park-enrichment/districts.geojson", import.meta.url);

const result = await runIngestion(config, {
  nationwidePreview,
  provincesPath,
  districtsPath,
  cacheDirUrl
});

const outputPath = flag("output")
  ? new URL(flag("output"), `file://${process.cwd()}/`)
  : new URL(`${config.cache_dir}/${sourceCode}-generic-preview.json`, cacheRoot);

await writeFile(outputPath, JSON.stringify(result, null, 2));

console.log(`===== ${sourceCode.toUpperCase()} (generic engine) =====`);
console.log(result.summary);
console.log("\nReview breakdown:", result.reviewBreakdown);
console.log(`\nSaved -> ${outputPath}`);

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { clean } from "./park-enrichment.mjs";
import { loadProvinceRegions } from "./province-boundaries.mjs";
import { loadDistrictRegions } from "./district-boundaries.mjs";
import { loadLicenseEvidence } from "./ulasav-license-evidence.mjs";
import { inspectDataset } from "./inspect-ulasav-full.mjs";

// Resumable full-batch runner — inspects EVERY distinct geo-capable dataset
// found in Stage B (71 total), not a sample. Writes results incrementally
// to a JSON file keyed by dataset_id; re-running skips dataset_ids already
// present in the output, so an interruption never loses progress and never
// re-downloads a dataset that already completed.

const cacheRoot = new URL("../data/park-enrichment/.cache/ulasav/", import.meta.url);
const argv = process.argv.slice(2);
const argVal = n => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
// Defaults reproduce the original behaviour exactly; --output/--only exist so a
// re-run (recovery sweep) never overwrites full-classification.json.
const outputPath = argVal("output") ? new URL(argVal("output"), `file://${process.cwd()}/`) : new URL("full-classification.json", cacheRoot);
const onlyIds = argVal("only") ? new Set(argVal("only").split(",")) : null;

const classified = JSON.parse(await readFile(new URL("classified-resources.json", cacheRoot), "utf8"));
const catalog = JSON.parse(await readFile(new URL("catalog.json", cacheRoot), "utf8"));
const catalogById = new Map(catalog.datasets.map(d => [d.dataset_id, d]));

function expectedProvinceFromOrg(orgTitle) {
  const m = clean(orgTitle).match(/^([^-]+?)(?:\s*-\s*.+)?\s+(?:Büyükşehir\s+)?Belediyesi$/i);
  return m ? clean(m[1]) : null;
}

// Format preference when a dataset has multiple geo-capable resources —
// prefer the richest/most structured format.
const FORMAT_RANK = { GEOJSON: 0, SHP: 1, KML: 2, CSV_COORDINATES: 3 };

const byDataset = new Map();
for (const r of classified.classifiedResources) {
  if (!["GEOJSON", "SHP", "KML", "CSV_COORDINATES"].includes(r.bucket)) continue;
  const existing = byDataset.get(r.dataset_id);
  if (!existing || FORMAT_RANK[r.bucket] < FORMAT_RANK[existing.bucket]) {
    byDataset.set(r.dataset_id, r);
  }
}

const allCandidates = [...byDataset.values()].map(r => {
  const ds = catalogById.get(r.dataset_id);
  return {
    dataset_id: r.dataset_id,
    dataset_title: r.dataset_title,
    organization_title: r.organization_title,
    expectedProvince: expectedProvinceFromOrg(r.organization_title),
    bucket: r.bucket,
    resource_id: r.resource_id,
    url: r.url,
    license_id: ds?.license_id ?? null,
    license_title: ds?.license_title ?? null,
    license_url: ds?.license_url ?? null
  };
});

console.log(`Total distinct geo-capable datasets to inspect: ${allCandidates.length}`);

// Resume support
let existingResults = [];
try {
  existingResults = JSON.parse(await readFile(outputPath, "utf8"));
  console.log(`Resuming — ${existingResults.length} already inspected.`);
} catch {
  // no prior output — starting fresh
}
const doneIds = new Set(existingResults.map(r => r.dataset_id));
const remaining = allCandidates.filter(c => !doneIds.has(c.dataset_id) && (!onlyIds || onlyIds.has(c.dataset_id)));
console.log(`Remaining to inspect: ${remaining.length}`);

const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);
const districtsPath = new URL("../data/park-enrichment/districts.geojson", import.meta.url);
const districtRegions = await loadDistrictRegions(districtsPath);
const licenseEvidence = await loadLicenseEvidence();

const workRoot = new URL("work/", cacheRoot);
await mkdir(workRoot, { recursive: true });

let overrides = {};
try { overrides = JSON.parse(await readFile(new URL("../data/ulasav-recovery-overrides.json", import.meta.url), "utf8")); } catch { /* none */ }
const ctx = { provinceRegions, districtRegions, licenseEvidence, workRoot, overrides };

// Same local CA-trust-store gap already documented for every acikveri.*
// .bel.tr subdomain used throughout this project (Konya/Ordu/Trabzon/
// Balıkesir download scripts all need it) — several of the first run's 9
// "fetch failed" errors were on exactly these domains. Scoped around this
// batch run only, not left global.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const results = [...existingResults];
let count = 0;
for (const candidate of remaining) {
  count++;
  process.stdout.write(`[${count}/${remaining.length}] ${candidate.organization_title} | ${candidate.dataset_title} (${candidate.bucket})... `);
  const r = await inspectDataset(candidate, ctx);
  console.log(r.status);
  results.push(r);
  // Persist after every dataset — true resumability, not just at the end.
  await writeFile(outputPath, JSON.stringify(results, null, 2));
}

delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const statusCounts = {};
for (const r of results) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

console.log("\n===== FULL ULASAV CLASSIFICATION (all datasets) =====");
console.log("Total inspected:", results.length);
console.log(statusCounts);
console.log(`\nSaved -> ${outputPath}`);

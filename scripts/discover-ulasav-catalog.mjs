import { writeFile, mkdir } from "node:fs/promises";

// Stage A: reproducible ULASAV (Ulusal Akıllı Şehir Açık Veri Platformu)
// CKAN catalog discovery. Read-only against ULASAV; writes only a local
// cache catalog. No downloads of actual resource files happen here — that
// is a later stage, per-candidate, after license/format triage.
//
// API base confirmed working directly (2026-09-22): /api/action/... —
// NOT the versioned /api/3/action/... path, which 404s.

const API_BASE = "https://ulasav.csb.gov.tr/api/action";

// Broad Turkish search terms, per explicit instruction. "yeşil alan" is
// discovery-only — finding a dataset via this term never implies PARK
// taxonomy; that decision happens later, per-dataset, by inspecting actual
// field values (Stage F).
const SEARCH_TERMS = [
  "park",
  "parklar",
  "yeşil alan",
  "yesil alan",
  "rekreasyon",
  "kent parkı",
  "kent parki"
];

async function ckanGet(action, params) {
  const url = new URL(`${API_BASE}/${action}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`${action} failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!body.success) throw new Error(`${action} returned success:false`);
  return body.result;
}

async function searchAll(query) {
  const rows = 200;
  let start = 0;
  const results = [];
  while (true) {
    const page = await ckanGet("package_search", { q: query, rows, start });
    results.push(...page.results);
    start += rows;
    if (start >= page.count || page.results.length === 0) break;
  }
  return results;
}

console.log("Fetching organization_list...");
const organizations = await ckanGet("organization_list", {});
console.log(`  ${organizations.length} organizations total.`);

const datasetsById = new Map();
const termHits = {};

for (const term of SEARCH_TERMS) {
  console.log(`Searching q="${term}"...`);
  const results = await searchAll(term);
  termHits[term] = results.length;
  console.log(`  ${results.length} datasets.`);
  for (const pkg of results) {
    if (!datasetsById.has(pkg.id)) datasetsById.set(pkg.id, { pkg, matchedTerms: [] });
    datasetsById.get(pkg.id).matchedTerms.push(term);
  }
}

const datasets = [...datasetsById.values()].map(({ pkg, matchedTerms }) => ({
  dataset_id: pkg.id,
  dataset_name: pkg.name,
  dataset_title: pkg.title,
  notes: pkg.notes ?? "",
  organization_name: pkg.organization?.name ?? null,
  organization_title: pkg.organization?.title ?? null,
  license_id: pkg.license_id ?? null,
  license_title: pkg.license_title ?? null,
  license_url: pkg.license_url ?? null,
  metadata_created: pkg.metadata_created,
  metadata_modified: pkg.metadata_modified,
  tags: (pkg.tags ?? []).map(t => t.display_name ?? t.name),
  matched_search_terms: matchedTerms,
  resources: (pkg.resources ?? []).map(r => ({
    resource_id: r.id,
    resource_name: r.name,
    format: (r.format ?? "").toUpperCase(),
    url: r.url,
    last_modified: r.last_modified ?? r.metadata_modified ?? null,
    size: r.size ?? null
  }))
}));

const outDir = new URL("../data/park-enrichment/.cache/ulasav/", import.meta.url);
await mkdir(outDir, { recursive: true });

const output = {
  generatedAt: new Date().toISOString(),
  apiBase: API_BASE,
  searchTerms: SEARCH_TERMS,
  organizationCount: organizations.length,
  organizations,
  termHits,
  distinctDatasetsFound: datasets.length,
  datasets
};

const outPath = new URL("catalog.json", outDir);
await writeFile(outPath, JSON.stringify(output));

console.log("\n===== ULASAV DISCOVERY CATALOG =====");
console.log("Organizations:", organizations.length);
console.log("Term hits:", termHits);
console.log("Distinct datasets (deduped across all terms):", datasets.length);

const formatCounts = {};
let totalResources = 0;
for (const d of datasets) {
  for (const r of d.resources) {
    totalResources++;
    formatCounts[r.format || "(none)"] = (formatCounts[r.format || "(none)"] ?? 0) + 1;
  }
}
console.log("Total resources:", totalResources);
console.log("Format distribution:", formatCounts);
console.log(`\nSaved -> ${outPath}`);

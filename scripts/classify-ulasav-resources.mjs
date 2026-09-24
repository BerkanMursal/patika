import { readFile, writeFile } from "node:fs/promises";
import { clean } from "./park-enrichment.mjs";

// Stage B: format classification, restricted to a "park-like candidate"
// shortlist (title/tag heuristic) so the expensive per-resource content
// sniffing (CSV/JSON coordinate detection) isn't wasted on the 139
// MP4/DOCX/PDF/PNG/JPEG/HTML resources already known to be irrelevant, or
// on hundreds of unrelated XLSX/CSV datasets about parking meters,
// Wi-Fi points, etc. that only coincidentally matched a broad search term.
//
// IMPORTANT: this shortlist is a DISCOVERY filter only — it does not imply
// PARK taxonomy. A dataset titled "Yeşil Alanlar" makes the shortlist (so
// it gets inspected) but is NOT assumed to be PARK data; that decision is
// made later (Stage F) by inspecting actual field values.

const cacheRoot = new URL("../data/park-enrichment/.cache/ulasav/", import.meta.url);
const catalog = JSON.parse(await readFile(new URL("catalog.json", cacheRoot), "utf8"));

const PARK_LIKE_TITLE_PATTERN = /park|yeşil ?alan|yesil ?alan|rekreasyon|bahçe|bahce|mesire/i;

function isParkLikeDataset(ds) {
  if (PARK_LIKE_TITLE_PATTERN.test(ds.dataset_title)) return true;
  if (ds.tags.some(t => PARK_LIKE_TITLE_PATTERN.test(t))) return true;
  return false;
}

const shortlist = catalog.datasets.filter(isParkLikeDataset);

// Format bucket, per the exact instructed taxonomy. Anything not
// GeoJSON/SHP/KML/KMZ/CSV/JSON gets UNSUPPORTED without further inspection
// (PDF/DOCX/MP4/PNG/JPEG/HTML/XLS/XLSX — not a geo format, not worth
// speculative support). WMS/API resources are real but each is a bespoke,
// single-occurrence pattern (see Stage A finding) — bucketed OTHER, not
// implemented.
function bucketFormat(format) {
  switch (format) {
    case "GEOJSON":
      return "GEOJSON";
    case "SHP":
      return "SHP";
    case "KML":
    case "KMZ":
      return "KML";
    case "CSV":
      return "CSV_UNVERIFIED"; // resolved to CSV_COORDINATES/CSV_NO_COORDINATES below
    case "JSON":
      return "JSON_UNVERIFIED"; // resolved to GEOJSON or OTHER below
    case "WMS":
    case "API":
      return "OTHER";
    default:
      return "UNSUPPORTED";
  }
}

async function sniffCsv(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Range: "bytes=0-4000" },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok && response.status !== 206) return { ok: false, reason: `HTTP ${response.status}` };
    const text = await response.text();
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const hasCoordColumns = /\b(lat|lon|lng|enlem|boylam|x_koor|y_koor|latitude|longitude|koordinat)\b/i.test(firstLine);
    return { ok: true, coordinates: hasCoordColumns, headerSample: firstLine.slice(0, 300) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function sniffJson(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const text = await response.text();
    let looksGeojson = false;
    try {
      const parsed = JSON.parse(text);
      looksGeojson =
        parsed?.type === "FeatureCollection" ||
        parsed?.type === "Feature" ||
        (Array.isArray(parsed?.features) && parsed.features.length > 0);
    } catch {
      looksGeojson = /"type"\s*:\s*"FeatureCollection"/.test(text.slice(0, 500));
    }
    return { ok: true, isGeojson: looksGeojson };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

const classifiedResources = [];

for (const ds of shortlist) {
  for (const r of ds.resources) {
    const bucket = bucketFormat(r.format);
    if (bucket === "UNSUPPORTED") {
      classifiedResources.push({ ...r, dataset_id: ds.dataset_id, dataset_title: ds.dataset_title, organization_title: ds.organization_title, bucket });
      continue;
    }
    classifiedResources.push({ ...r, dataset_id: ds.dataset_id, dataset_title: ds.dataset_title, organization_title: ds.organization_title, bucket });
  }
}

// Resolve CSV_UNVERIFIED / JSON_UNVERIFIED by content sniff — bounded to
// the shortlist only (not all 105+16 catalog-wide).
let sniffCount = 0;
for (const r of classifiedResources) {
  if (r.bucket === "CSV_UNVERIFIED") {
    sniffCount++;
    const sniff = await sniffCsv(r.url);
    r.bucket = sniff.ok ? (sniff.coordinates ? "CSV_COORDINATES" : "CSV_NO_COORDINATES") : "UNSUPPORTED";
    r.sniff = sniff;
  } else if (r.bucket === "JSON_UNVERIFIED") {
    sniffCount++;
    const sniff = await sniffJson(r.url);
    r.bucket = sniff.ok && sniff.isGeojson ? "GEOJSON" : sniff.ok ? "OTHER" : "UNSUPPORTED";
    r.sniff = sniff;
  }
}

const formatCounts = {};
for (const r of classifiedResources) formatCounts[r.bucket] = (formatCounts[r.bucket] ?? 0) + 1;

const output = {
  generatedAt: new Date().toISOString(),
  parkLikeShortlistCount: shortlist.length,
  totalCatalogDatasets: catalog.datasets.length,
  resourcesClassified: classifiedResources.length,
  sniffedCount: sniffCount,
  formatCounts,
  shortlistDatasetIds: shortlist.map(d => d.dataset_id),
  classifiedResources
};

await writeFile(new URL("classified-resources.json", cacheRoot), JSON.stringify(output));

console.log("===== ULASAV FORMAT CLASSIFICATION (park-like shortlist only) =====");
console.log("Park-like shortlist datasets:", shortlist.length, "/", catalog.datasets.length, "total catalog datasets");
console.log("Resources classified:", classifiedResources.length, "(", sniffCount, "content-sniffed for CSV/JSON)");
console.log("Format bucket counts:", formatCounts);
console.log(`\nSaved -> data/park-enrichment/.cache/ulasav/classified-resources.json`);

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clean, nameKey } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";
import { loadDistrictRegions, districtsForProvince, districtsContaining } from "./district-boundaries.mjs";

const execFileAsync = promisify(execFile);

// Stages C+D+E+F+G combined: a GENERIC (not per-city) multi-format
// inspector. Given a resource URL + declared format bucket, it:
//   C. loads the resource via a generic format reader (GeoJSON pass-through;
//      SHP/KML/KMZ via ogr2ogr; CSV via manual coordinate-column parsing)
//   D. detects source CRS (ogrinfo on the converted layer) and ALWAYS
//      explicitly reprojects to EPSG:4326 via ogr2ogr -t_srs (never assumes
//      WGS84 for SHP/KML; CSV has no CRS metadata at all, so it is flagged
//      "assumed_wgs84_unverified" rather than silently trusted)
//   E. identity validation (guesses a stable id field, checks null/duplicate
//      coverage)
//   F. taxonomy validation (looks for a type/category field and pattern-
//      matches its values against PARK/YESIL_ALAN/PLAYGROUND/REFUJ/SPORT/
//      PIKNIK/GARDEN/UNKNOWN; falls back to dataset-title matching only as
//      a WEAKER signal, never auto-promoted to READY on title alone)
//   G. classifies into the 9-way dataset quality system with an exact reason
//
// Read-only against every remote source. Writes only to
// data/park-enrichment/.cache/ulasav/inspections/. Never merges, never
// touches nationwide-canonical-preview.json.

const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);
const districtsPath = new URL("../data/park-enrichment/districts.geojson", import.meta.url);
const districtRegions = await loadDistrictRegions(districtsPath);

const workRoot = new URL("../data/park-enrichment/.cache/ulasav/work/", import.meta.url);
await mkdir(workRoot, { recursive: true });

const TURKEY_BBOX = { minLat: 35, maxLat: 43, minLon: 25, maxLon: 45 };
function coordPlausible(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= TURKEY_BBOX.minLat && lat <= TURKEY_BBOX.maxLat && lon >= TURKEY_BBOX.minLon && lon <= TURKEY_BBOX.maxLon;
}

const TAXONOMY_KEYWORDS = [
  ["PLAYGROUND", /çocuk\s*oyun|oyun\s*alan|playground/i],
  ["REFUJ", /ref[üu]j/i],
  ["SPORT", /spor\s*(alan|tesis)|fitness/i],
  ["PIKNIK", /piknik|mesire/i],
  ["GARDEN", /bah[çc]e|botanik|garden/i],
  ["YESIL_ALAN", /ye[şs]il\s*alan/i],
  ["PARK", /^park$|park[iı]?$|\bpark\b/i]
];

function classifyTaxonomyValue(value) {
  const v = clean(value);
  if (!v) return "UNKNOWN";
  for (const [bucket, pattern] of TAXONOMY_KEYWORDS) {
    if (pattern.test(v)) return bucket;
  }
  return "UNKNOWN";
}

// --- format loaders -------------------------------------------------

async function downloadToFile(url, destPath) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
  return buffer.length;
}

async function loadGeoJSON(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const geojson = JSON.parse(text);
  return { features: geojson.features ?? [], sourceCrs: "assumed EPSG:4326 (GeoJSON spec default)", reprojected: false };
}

async function loadViaOgr2ogr(url, workDir, { isZip = false, mainFileGlob = null } = {}) {
  await mkdir(workDir, { recursive: true });
  const rawPath = new URL(`raw${isZip ? ".zip" : ""}`, workDir);
  await downloadToFile(url, rawPath);

  let sourcePath = rawPath;
  if (isZip) {
    await execFileAsync("unzip", ["-o", "-q", rawPath.pathname, "-d", workDir.pathname]);
    const { stdout } = await execFileAsync("bash", ["-c", `find '${workDir.pathname}' -iname '*.shp' | head -1`]);
    const shpPath = stdout.trim();
    if (!shpPath) throw new Error("no .shp found inside zip");
    sourcePath = { pathname: shpPath };
  }

  // Detect source CRS before reprojecting.
  let sourceCrs = "unknown";
  try {
    const { stdout } = await execFileAsync("ogrinfo", ["-al", "-so", sourcePath.pathname]);
    const match = stdout.match(/ID\["EPSG",(\d+)\]/g);
    const nameMatch = stdout.match(/(?:PROJCRS|GEOGCRS|PROJCS|GEOGCS)\["([^"]+)"/);
    sourceCrs = nameMatch ? `${nameMatch[1]}${match ? " (" + match[match.length - 1] + ")" : ""}` : "unknown";
  } catch {
    sourceCrs = "undetectable";
  }

  const outPath = new URL("converted.geojson", workDir);
  await execFileAsync("ogr2ogr", ["-f", "GeoJSON", "-t_srs", "EPSG:4326", outPath.pathname, sourcePath.pathname]);
  const geojson = JSON.parse(await readFile(outPath, "utf8"));
  return { features: geojson.features ?? [], sourceCrs, reprojected: true };
}

async function loadCsvCoordinates(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { features: [], sourceCrs: "n/a (CSV)", reprojected: false };
  const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const header = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ""));
  const latIdx = header.findIndex(h => /^(lat|enlem|latitude|y)$/i.test(h));
  const lonIdx = header.findIndex(h => /^(lon|lng|boylam|longitude|x)$/i.test(h));
  if (latIdx === -1 || lonIdx === -1) return { features: [], sourceCrs: "n/a (CSV, no coord columns)", reprojected: false };

  const features = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(delimiter).map(c => c.trim().replace(/^"|"$/g, ""));
    const lat = Number(cols[latIdx]?.replace(",", "."));
    const lon = Number(cols[lonIdx]?.replace(",", "."));
    const properties = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties });
  }
  return { features, sourceCrs: "assumed EPSG:4326 unverified (CSV has no CRS metadata)", reprojected: false, crsAssumed: true };
}

// --- feature normalization + inspection ------------------------------

function extractRepresentativePoint(feature) {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === "Point") return geom.coordinates;
  if (geom.type === "Polygon") return geom.coordinates?.[0]?.[0] ?? null;
  if (geom.type === "MultiPolygon") return geom.coordinates?.[0]?.[0]?.[0] ?? null;
  if (geom.type === "LineString") return geom.coordinates?.[0] ?? null;
  return null;
}

function guessIdField(features) {
  if (features.length === 0) return null;
  const keys = Object.keys(features[0].properties ?? {});
  const candidates = keys.filter(k => /^(objectid|id|fid|uuid|.*_id|poi_id)$/i.test(k));
  let best = null;
  let bestScore = -1;
  for (const key of [...candidates, ...(keys.length && candidates.length === 0 ? [] : [])]) {
    const values = features.map(f => f.properties?.[key]);
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== "");
    const distinct = new Set(nonNull);
    const score = nonNull.length && distinct.size === nonNull.length ? nonNull.length : distinct.size / (nonNull.length || 1);
    if (score > bestScore) {
      bestScore = score;
      best = { field: key, nonNullCount: nonNull.length, distinctCount: distinct.size, total: features.length };
    }
  }
  // Also consider GeoJSON top-level feature.id
  const topLevelIds = features.map(f => f.id).filter(v => v !== null && v !== undefined);
  const topLevelDistinct = new Set(topLevelIds);
  if (topLevelIds.length === features.length && topLevelDistinct.size === topLevelIds.length) {
    if (!best || topLevelIds.length > best.nonNullCount) {
      best = { field: "(GeoJSON feature.id)", nonNullCount: topLevelIds.length, distinctCount: topLevelDistinct.size, total: features.length };
    }
  }
  return best;
}

function guessTaxonomyField(features, datasetTitle) {
  if (features.length === 0) return { field: null, values: {}, sourceLevel: "dataset_title_only", bucket: classifyTaxonomyValue(datasetTitle) };
  const keys = Object.keys(features[0].properties ?? {});
  const typeFieldCandidates = keys.filter(k => /^(tur|tip|type|kategori|category|alt_nitelik|faaliyet|nitelik|aciklama|description|name)$/i.test(k));
  for (const field of typeFieldCandidates) {
    const values = features.map(f => f.properties?.[field]).filter(v => v !== null && v !== undefined && v !== "");
    const distinctValues = [...new Set(values.map(String))].slice(0, 20);
    if (distinctValues.length > 0 && distinctValues.length < features.length) {
      const buckets = {};
      for (const v of distinctValues) buckets[classifyTaxonomyValue(v)] = (buckets[classifyTaxonomyValue(v)] ?? 0) + 1;
      return { field, distinctValues, sourceLevel: "row_level", buckets };
    }
  }
  return { field: null, sourceLevel: "dataset_title_only", bucket: classifyTaxonomyValue(datasetTitle) };
}

async function inspectCandidate(candidate) {
  const workDir = new URL(`${candidate.dataset_id}-${candidate.resource_id ?? "r"}/`, workRoot);
  const result = { ...candidate, status: null, reason: null, details: {} };

  try {
    let loaded;
    if (candidate.bucket === "GEOJSON") {
      loaded = await loadGeoJSON(candidate.url);
    } else if (candidate.bucket === "SHP") {
      loaded = await loadViaOgr2ogr(candidate.url, workDir, { isZip: candidate.url.toLowerCase().endsWith(".zip") });
    } else if (candidate.bucket === "KML") {
      loaded = await loadViaOgr2ogr(candidate.url, workDir, { isZip: candidate.url.toLowerCase().endsWith(".kmz") });
    } else if (candidate.bucket === "CSV_COORDINATES") {
      loaded = await loadCsvCoordinates(candidate.url);
    } else {
      result.status = "UNSUPPORTED_FORMAT";
      result.reason = `bucket ${candidate.bucket} has no generic reader`;
      return result;
    }

    const rawCount = loaded.features.length;
    result.details.sourceCrs = loaded.sourceCrs;
    result.details.reprojected = loaded.reprojected;
    result.details.crsAssumedUnverified = Boolean(loaded.crsAssumed);
    result.details.rawFeatureCount = rawCount;

    if (rawCount === 0) {
      result.status = "BLOCKED_SCHEMA";
      result.reason = "0 features loaded";
      return result;
    }

    // Geometry validity
    let validGeometry = 0;
    const points = [];
    for (const f of loaded.features) {
      const p = extractRepresentativePoint(f);
      if (p && coordPlausible(p[1], p[0])) {
        validGeometry++;
        points.push({ feature: f, lon: p[0], lat: p[1] });
      }
    }
    result.details.validGeometryCount = validGeometry;

    if (validGeometry === 0) {
      result.status = "BLOCKED_CRS";
      result.reason = `0/${rawCount} coordinates plausible after reprojection (source CRS: ${loaded.sourceCrs})`;
      return result;
    }

    // Identity
    const idInfo = guessIdField(loaded.features);
    result.details.identity = idInfo;
    let identityStatus;
    if (!idInfo || idInfo.nonNullCount === 0) {
      identityStatus = "BLOCKED_IDENTITY";
    } else if (idInfo.nonNullCount === idInfo.total && idInfo.distinctCount === idInfo.nonNullCount) {
      identityStatus = "IDENTITY_OK";
    } else {
      identityStatus = "PARTIAL_IDENTITY";
    }
    result.details.identityStatus = identityStatus;

    // Taxonomy
    const taxInfo = guessTaxonomyField(loaded.features, candidate.dataset_title);
    result.details.taxonomy = taxInfo;

    // Province/district coverage (checked against the candidate's
    // declared expected province, parsed from organization name — never
    // trusted blindly, only used to compute a coverage ratio).
    let provinceMatches = 0;
    let districtResolved = 0;
    if (candidate.expectedProvince) {
      for (const { lon, lat } of points) {
        const contains = provincesContaining(provinceRegions, lon, lat);
        if (contains.some(r => r.name === candidate.expectedProvince)) {
          provinceMatches++;
          const scoped = districtsForProvince(districtRegions, provinceRegions, candidate.expectedProvince, provincesContaining);
          if (districtsContaining(scoped, lon, lat).length === 1) districtResolved++;
        }
      }
    }
    result.details.provinceCoverage = candidate.expectedProvince ? `${provinceMatches}/${validGeometry}` : "n/a (no expected province parsed)";
    result.details.districtCoverage = candidate.expectedProvince ? `${districtResolved}/${provinceMatches || 1}` : "n/a";

    // License
    const licenseKnownOpen = candidate.license_id === "ulasav-license" || /cc[\s-]?by/i.test(candidate.license_title ?? "");
    result.details.licenseStatus = licenseKnownOpen ? "SAFE_OPEN (license_id/title matches known-open pattern; not individually text-verified in this batch pass)" : "LICENSE_UNVERIFIED";

    // Final 9-way classification
    if (!licenseKnownOpen) {
      result.status = "BLOCKED_LICENSE";
      result.reason = `license_id='${candidate.license_id}' does not match a known-open pattern`;
    } else if (identityStatus === "BLOCKED_IDENTITY") {
      result.status = "BLOCKED_IDENTITY";
      result.reason = "no field with any non-null values found that could serve as a stable id";
    } else if (taxInfo.sourceLevel === "dataset_title_only" && taxInfo.bucket !== "PARK") {
      result.status = "NOT_PARK_DATA";
      result.reason = `no row-level taxonomy field; dataset title suggests '${taxInfo.bucket}', not PARK`;
    } else if (taxInfo.sourceLevel === "row_level" && !(taxInfo.buckets?.PARK > 0)) {
      result.status = "BLOCKED_TAXONOMY";
      result.reason = `row-level taxonomy field '${taxInfo.field}' present but no rows classify as PARK: ${JSON.stringify(taxInfo.buckets)}`;
    } else if (taxInfo.sourceLevel === "dataset_title_only" && taxInfo.bucket === "PARK") {
      result.status = "READY_AFTER_GENERIC_FORMAT_SUPPORT";
      result.reason = "geometry/identity/license OK; taxonomy confidence is WEAK (dataset-title-only, no row-level type field) — needs a human sanity check before treating as READY_FOR_RECONCILIATION, per instruction that title alone is not enough";
      result.details.weakTaxonomyWarning = true;
    } else if (identityStatus === "PARTIAL_IDENTITY") {
      result.status = "READY_AFTER_GENERIC_FORMAT_SUPPORT";
      result.reason = `identity only partially covered (${idInfo.nonNullCount}/${idInfo.total} non-null, ${idInfo.distinctCount} distinct) — needs a decision on how to handle the gap before reconciliation`;
    } else {
      result.status = "READY_FOR_RECONCILIATION";
      result.reason = `license OK, identity OK (${idInfo.field}, ${idInfo.distinctCount}/${idInfo.total}), row-level taxonomy confirms PARK rows present, geometry valid after explicit CRS handling`;
    }

    return result;
  } catch (error) {
    result.status = "BLOCKED_SCHEMA";
    result.reason = `load error: ${error.message}`;
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- batch candidate list --------------------------------------------
// A curated, representative subset (not all 71 datasets, not all 123
// resources) chosen to span every format bucket found in Stage B, every
// already-integrated regression fixture from the earlier POC, and enough
// distinct organizations (büyükşehir + district level) to test the
// discovery pattern broadly. Per instruction: do not manually research
// municipalities one-by-one exhaustively — this proves the GENERIC
// pipeline works across a representative sample; the same pipeline is
// directly reusable for the remaining 56 datasets not inspected here.

const CANDIDATES = [
  { dataset_id: "van-parklar", dataset_title: "Van Büyükşehir Belediyesi Parklar", organization_title: "Van Büyükşehir Belediyesi", expectedProvince: "Van", bucket: "SHP", resource_id: "van", license_id: "ulasav-license", license_title: "Açık Veri ULASAV", url: "https://ulasav.csb.gov.tr/dataset/2769db3e-a0e5-4f09-b0fa-90ce20abcb81/resource/7a727e37-70ea-435c-96bb-0d8f6ca0c27e/download/parklar.zip" },
  { dataset_id: "osmaniye-parklar", dataset_title: "Osmaniye İli Merkez İlçesi Park Alanları", organization_title: "Osmaniye Belediyesi", expectedProvince: "Osmaniye", bucket: "KML", resource_id: "osmaniye", license_id: "ulasav-license", license_title: "Açık Veri ULASAV", url: "https://ulasav.csb.gov.tr/dataset/2d0ba934-afdc-4b34-91c7-fad9cad9c14a/resource/b2ef3747-432f-4c02-ae44-5b48f26cba97/download/osmaniye_parklar.kml" },
  { dataset_id: "bursa-parklar", dataset_title: "Bursa Parklar", organization_title: "Bursa Büyükşehir Belediyesi", expectedProvince: "Bursa", bucket: "GEOJSON", resource_id: "bursa", license_id: "bursa-mm", license_title: "Bursa Açık Yeşil Lisansı (CC BY 4.0)", url: "https://bapi.bursa.bel.tr/apigateway/acik_veri_turizm/parklar" }
];

// Pull remaining candidates directly from the Stage B classification
// output so this stays data-driven rather than hardcoding every URL.
const classified = JSON.parse(await readFile(new URL("../data/park-enrichment/.cache/ulasav/classified-resources.json", import.meta.url), "utf8"));

function expectedProvinceFromOrg(orgTitle) {
  // Best-effort parse of "<Province> Büyükşehir Belediyesi" / "<Province> -
  // <District> Belediyesi" / "<Province> Belediyesi" naming conventions —
  // NEVER trusted as final truth, only used to compute a coverage ratio
  // that the point-in-polygon check either confirms or contradicts.
  const m = orgTitle.match(/^([^-]+?)(?:\s*-\s*.+)?\s+(?:Büyükşehir\s+)?Belediyesi$/i);
  return m ? clean(m[1]) : null;
}

const wanted = [
  ["kocaeli-kobis", /KOBİS Park Yerleri/i],
  ["istanbul-parklar-yesil", /İstanbul Park ve Yeşil Alan Koordinatları/i],
  ["usak-mesire", /Mesire ve Dinlenme Alanları/i],
  ["kirikkale-merkez-park", /Kırıkkale Belediyesi - Park Alanları/i],
  ["kirikkale-yahsihan-yesil", /Yahşihan Belediyesi - Yeşil Alanlar/i],
  ["manisa-saruhanli", /Saruhanlı Parklar/i],
  ["balikesir-milli-park", /Milli Parklar Konum Verileri/i],
  ["balikesir-yesil-alan", /Yeşil Alanlar Konum Bilgileri/i],
  ["kayseri-kocasinan", /Park ve Bahçeler/i],
  ["sivas-millet-bahce", /MİLLET BAHÇELERİ/i],
  ["tuzla-parklar", /Tuzla Belediyesinde Bulunan Parklar ve İmkanlar$/i],
  ["konya-selcuklu", /Selçuklu Belediyesi Parklar/i]
];

for (const [id, pattern] of wanted) {
  const match = classified.classifiedResources.find(r => pattern.test(r.dataset_title) && ["GEOJSON", "SHP", "KML", "CSV_COORDINATES"].includes(r.bucket));
  if (match) {
    CANDIDATES.push({
      dataset_id: id,
      dataset_title: match.dataset_title,
      organization_title: match.organization_title,
      expectedProvince: expectedProvinceFromOrg(match.organization_title),
      bucket: match.bucket,
      resource_id: match.resource_id,
      license_id: classified.datasets?.find?.(() => false)?.license_id, // not present per-resource; filled below
      url: match.url
    });
  }
}

// license_id/title aren't carried on classified resources — pull them from
// the original catalog by dataset_id.
const catalog = JSON.parse(await readFile(new URL("../data/park-enrichment/.cache/ulasav/catalog.json", import.meta.url), "utf8"));
const catalogById = new Map(catalog.datasets.map(d => [d.dataset_id, d]));
for (const c of CANDIDATES) {
  const ds = catalogById.get(c.dataset_id) ?? [...catalogById.values()].find(d => d.dataset_title === c.dataset_title);
  if (ds) {
    c.license_id = c.license_id ?? ds.license_id;
    c.license_title = c.license_title ?? ds.license_title;
  }
}

console.log(`Inspecting ${CANDIDATES.length} candidates...\n`);

const results = [];
for (const candidate of CANDIDATES) {
  process.stdout.write(`- ${candidate.organization_title} | ${candidate.dataset_title} (${candidate.bucket})... `);
  const r = await inspectCandidate(candidate);
  console.log(r.status);
  results.push(r);
}

const outPath = new URL("../data/park-enrichment/.cache/ulasav/inspection-results.json", import.meta.url);
await writeFile(outPath, JSON.stringify(results, null, 2));

const statusCounts = {};
for (const r of results) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

console.log("\n===== INSPECTION SUMMARY =====");
console.log(statusCounts);
console.log(`\nSaved -> ${outPath}`);

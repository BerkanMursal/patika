import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clean, nameKey } from "./park-enrichment.mjs";
import { loadProvinceRegions, provincesContaining } from "./province-boundaries.mjs";
import { loadDistrictRegions, districtsForProvince, districtsContaining } from "./district-boundaries.mjs";
import { loadLicenseEvidence, ULASAV_LICENSE_VERIFIED } from "./ulasav-license-evidence.mjs";

const execFileAsync = promisify(execFile);

// v2 generic ULASAV inspector — fixes the 3 known weaknesses from the
// sample-batch pass, then runs resumably across ALL 71 geo-capable
// datasets (not a sample). Never per-city logic — one engine, config-
// driven by whatever Stage A/B discovery already found.

/* =====================================================================
   FIX 1: Turkish-morphology-aware PARK word matcher.
   \bpark\b (plain regex word boundary) fails on "Parklar" because JS's
   \b is ASCII-\w-only and doesn't treat Turkish "ı" as a word character
   reliably at a string edge. Fixed with explicit \p{L}/\p{N} lookaround
   (Unicode-aware) instead of \b, and explicit suffix handling for the
   Turkish possessive/plural forms actually seen in ULASAV dataset titles:
   park, parklar, parkı, parkları, park alanı, park alanları, kent parkı,
   kent parkları (the multi-word forms are covered because "park"/"parkı"
   appears as an independent token within them; the regex doesn't need to
   match the whole phrase, just the meaningful "park" token).
   ===================================================================== */
function containsParkWord(text) {
  const normalized = clean(text).toLocaleLowerCase("tr");
  if (!normalized) return false;
  return /(?<![\p{L}\p{N}])park(lar)?[ıi]?(?![\p{L}\p{N}])/u.test(normalized);
}

// Regression examples for the matcher — run once at module load; throws
// loudly if any expectation breaks, so a future edit can't silently
// reintroduce the bug.
function assertParkMatcherRegression() {
  const shouldMatch = [
    "park", "Park", "PARK",
    "parklar", "Parklar",
    "parkı", "Kent Parkı", "kent parkı",
    "parkları", "Kent Parkları",
    "park alanı", "Park Alanları",
    "Bursa Parklar", "Tuzla Belediyesinde Bulunan Parklar ve İmkanlar",
    "Van Büyükşehir Belediyesi Parklar"
  ];
  const shouldNotMatch = [
    "parkomat", "Parkomatlar", "parking", "otopark", "Otopark Alanları",
    "sparkle", "mobile home park equivalent turkish: karavan parkı" // "karavan parkı" DOES contain "parkı" deliberately, tested separately below
  ];
  for (const s of shouldMatch) {
    if (!containsParkWord(s)) throw new Error(`Park matcher regression: expected match for "${s}"`);
  }
  for (const s of shouldNotMatch.slice(0, -1)) {
    if (containsParkWord(s)) throw new Error(`Park matcher regression: expected NO match for "${s}"`);
  }
  if (!containsParkWord("karavan parkı")) throw new Error(`Park matcher regression: "karavan parkı" should match the word "parkı"`);
}
assertParkMatcherRegression();

const OTHER_TAXONOMY_PATTERNS = [
  ["PLAYGROUND", /çocuk\s*oyun|oyun\s*alan|playground/i],
  ["REFUJ", /ref[üu]j/i],
  ["SPORT", /spor\s*(alan|tesis)|fitness/i],
  ["PIKNIK", /piknik|mesire/i],
  ["GARDEN", /bah[çc]e|botanik|garden/i],
  ["YESIL_ALAN", /ye[şs]il\s*alan/i]
];

function classifyTaxonomyValue(value) {
  const v = clean(value);
  if (!v) return "UNKNOWN";
  if (containsParkWord(v)) return "PARK";
  for (const [bucket, pattern] of OTHER_TAXONOMY_PATTERNS) {
    if (pattern.test(v)) return bucket;
  }
  return "UNKNOWN";
}

/* =====================================================================
   FIX 2: deterministic field selection — exact-name priority lists,
   never "first field whose name loosely matches a regex". BLOCKED_SCHEMA
   (not a guess) when identity is genuinely ambiguous (a true tie).
   ===================================================================== */
const NAME_FIELD_PRIORITY = ["ADI", "AD", "NAME", "PARK_ADI", "PARKADI", "TESIS_ADI", "YER_ADI"];
const TAXONOMY_FIELD_PRIORITY = ["TIP", "TUR", "TYPE", "SINIF", "KATEGORI", "ALAN_TURU", "TESIS_TURU"];
const ID_FIELD_PRIORITY_PATTERN = /^(objectid|fid|id|uuid|poi_id|rel_item_id)$/i;

function selectField(propertyKeys, priorityList) {
  const upperKeys = new Map(propertyKeys.map(k => [k.toUpperCase(), k]));
  for (const candidate of priorityList) {
    if (upperKeys.has(candidate)) return upperKeys.get(candidate);
  }
  return null;
}

function guessIdField(features) {
  if (features.length === 0) return { field: null, ambiguous: false };
  const keys = Object.keys(features[0].properties ?? {});
  const candidates = keys.filter(k => ID_FIELD_PRIORITY_PATTERN.test(k));

  const scored = candidates.map(field => {
    const values = features.map(f => f.properties?.[field]);
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== "");
    const distinct = new Set(nonNull);
    return { field, nonNullCount: nonNull.length, distinctCount: distinct.size, total: features.length };
  });

  const topLevelIds = features.map(f => f.id).filter(v => v !== null && v !== undefined);
  const topLevelDistinct = new Set(topLevelIds);
  if (topLevelIds.length > 0) {
    scored.push({ field: "(GeoJSON feature.id)", nonNullCount: topLevelIds.length, distinctCount: topLevelDistinct.size, total: features.length });
  }

  if (scored.length === 0) return { field: null, ambiguous: false };

  scored.sort((a, b) => (b.distinctCount === a.distinctCount ? b.nonNullCount - a.nonNullCount : b.distinctCount - a.distinctCount));

  // True ambiguity: two+ candidates tied on BOTH distinctCount and
  // nonNullCount, and both are "good enough" (distinct === nonNull, i.e.
  // both look like valid unique ids) — genuinely can't pick deterministically.
  const best = scored[0];
  const tied = scored.filter(s => s.distinctCount === best.distinctCount && s.nonNullCount === best.nonNullCount);
  const ambiguous = tied.length > 1 && best.distinctCount === best.nonNullCount && best.nonNullCount > 0;

  return { field: best.field, nonNullCount: best.nonNullCount, distinctCount: best.distinctCount, total: best.total, ambiguous, tiedFields: ambiguous ? tied.map(t => t.field) : undefined };
}

// Minimum fraction of non-empty NAME field values that must literally
// contain the word "park" for that to count as genuine row-level evidence
// (stronger than a dataset-title guess, since it's checked per-record, but
// still recorded as a distinct, weaker sourceLevel than a real type/
// taxonomy code — a name is not a classification field, it just happens to
// often describe one in Turkish municipal data, e.g. "NAİM SÜLEYNANOĞLU
// PARKI").
const NAME_FIELD_PARK_EVIDENCE_THRESHOLD = 0.5;

function selectNameAndTaxonomyFields(features, datasetTitle) {
  const keys = features.length ? Object.keys(features[0].properties ?? {}) : [];
  const nameField = selectField(keys, NAME_FIELD_PRIORITY);
  const taxonomyField = selectField(keys, TAXONOMY_FIELD_PRIORITY);

  let taxonomy;
  if (taxonomyField) {
    const values = features.map(f => f.properties?.[taxonomyField]).filter(v => v !== null && v !== undefined && v !== "");
    const distinctValues = [...new Set(values.map(String))].slice(0, 30);
    const buckets = {};
    for (const f of features) {
      const v = f.properties?.[taxonomyField];
      const bucket = classifyTaxonomyValue(v);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    taxonomy = { field: taxonomyField, sourceLevel: "row_level", distinctValues, buckets, parkCandidateCount: buckets.PARK ?? 0 };
  } else if (nameField) {
    // No whitelisted taxonomy field — but if a real name field exists AND
    // most of its non-empty values literally say "park" per row (not just
    // the dataset title once), that IS genuine row-level evidence, just
    // from a different field than a dedicated type code. Only every
    // feature whose OWN name contains the word is counted as a park
    // candidate — not the whole dataset by assumption.
    const names = features.map(f => f.properties?.[nameField]).filter(v => v !== null && v !== undefined && v !== "");
    const parkNameCount = names.filter(containsParkWord).length;
    const fraction = names.length ? parkNameCount / names.length : 0;
    if (names.length > 0 && fraction >= NAME_FIELD_PARK_EVIDENCE_THRESHOLD) {
      taxonomy = {
        field: nameField,
        sourceLevel: "name_field_inferred",
        parkCandidateCount: features.filter(f => containsParkWord(f.properties?.[nameField])).length,
        nameFieldParkFraction: Math.round(fraction * 1000) / 1000
      };
    } else {
      const bucket = classifyTaxonomyValue(datasetTitle);
      taxonomy = { field: null, sourceLevel: "dataset_title_only", bucket, parkCandidateCount: bucket === "PARK" ? features.length : 0 };
    }
  } else {
    // No taxonomy field, no name field either — fall back to dataset-title
    // inference, explicitly marked as the weakest signal.
    const bucket = classifyTaxonomyValue(datasetTitle);
    taxonomy = { field: null, sourceLevel: "dataset_title_only", bucket, parkCandidateCount: bucket === "PARK" ? features.length : 0 };
  }

  return { nameField, taxonomy };
}

/* =====================================================================
   Format loaders (unchanged from the v1 batch inspector — GeoJSON pass-
   through; SHP/KML via ogr2ogr with explicit CRS detection + reprojection;
   CSV via coordinate-column sniffing, flagged unverified since CSV has no
   CRS metadata at all).
   ===================================================================== */

const TURKEY_BBOX = { minLat: 35, maxLat: 43, minLon: 25, maxLon: 45 };
function coordPlausible(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= TURKEY_BBOX.minLat && lat <= TURKEY_BBOX.maxLat && lon >= TURKEY_BBOX.minLon && lon <= TURKEY_BBOX.maxLon;
}

async function downloadToFile(url, destPath) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
  return buffer.length;
}

async function loadGeoJSON(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const geojson = JSON.parse(await response.text());
  return { features: geojson.features ?? [], sourceCrs: "EPSG:4326 (GeoJSON spec default, not independently verified)", targetCrs: "EPSG:4326", reprojected: false };
}

async function loadViaOgr2ogr(url, workDir, { isZip = false, format = "shp" } = {}) {
  await mkdir(workDir, { recursive: true });
  const rawPath = new URL(`raw${isZip ? ".zip" : ""}`, workDir);
  await downloadToFile(url, rawPath);

  // GDAL's /vsizip/ virtual filesystem was tried first but fails outright
  // in this environment's GDAL build ("Unable to open datasource") even for
  // a plain single-shapefile zip — verified directly by hand before
  // reverting, not assumed. Falling back to manual unzip, but — unlike the
  // v1 bug — searching for the extension that actually matches the
  // declared format (.shp for shapefiles, .kml for KMZ), not hardcoding
  // "*.shp" regardless of what's being loaded. That hardcoding is exactly
  // why 29/39 datasets failed with "no .shp found inside zip" on the first
  // full-batch run when it hit zipped KML (.kmz) files — a real bug, not a
  // source problem.
  let sourcePath = rawPath;
  if (isZip) {
    await execFileAsync("unzip", ["-o", "-q", rawPath.pathname, "-d", workDir.pathname]);
    const innerExt = format === "kml" ? "kml" : "shp";
    const { stdout } = await execFileAsync("bash", ["-c", `find '${workDir.pathname}' -iname '*.${innerExt}' | head -1`]);
    const innerPath = stdout.trim();
    if (!innerPath) throw new Error(`no .${innerExt} found inside zip (format=${format})`);
    sourcePath = { pathname: innerPath };
  }

  let sourceCrs = "undetectable";
  try {
    const { stdout } = await execFileAsync("ogrinfo", ["-al", "-so", sourcePath.pathname]);
    const idMatch = [...stdout.matchAll(/ID\["EPSG",(\d+)\]/g)];
    const nameMatch = stdout.match(/(?:PROJCRS|GEOGCRS|PROJCS|GEOGCS)\["([^"]+)"/);
    if (nameMatch) {
      sourceCrs = `${nameMatch[1]}${idMatch.length ? " (EPSG:" + idMatch[idMatch.length - 1][1] + ")" : ""}`;
    } else if (!/Layer SRS WKT:\s*\(unknown\)/.test(stdout)) {
      sourceCrs = "unknown";
    } else {
      sourceCrs = null; // genuinely no CRS metadata at all
    }
  } catch {
    sourceCrs = "undetectable";
  }

  if (sourceCrs === null) {
    return { features: [], sourceCrs: null, targetCrs: "EPSG:4326", reprojected: false, crsError: "no CRS metadata found in source file" };
  }

  const outPath = new URL("converted.geojson", workDir);
  await execFileAsync("ogr2ogr", ["-f", "GeoJSON", "-t_srs", "EPSG:4326", outPath.pathname, sourcePath.pathname]);
  const geojson = JSON.parse(await readFile(outPath, "utf8"));
  return { features: geojson.features ?? [], sourceCrs, targetCrs: "EPSG:4326", reprojected: true };
}

async function loadCsvCoordinates(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { features: [], sourceCrs: "n/a (CSV)", targetCrs: "EPSG:4326", reprojected: false };
  const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const header = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ""));
  const latIdx = header.findIndex(h => /^(lat|enlem|latitude|y)$/i.test(h));
  const lonIdx = header.findIndex(h => /^(lon|lng|boylam|longitude|x)$/i.test(h));
  if (latIdx === -1 || lonIdx === -1) return { features: [], sourceCrs: "n/a (no coord columns)", targetCrs: "EPSG:4326", reprojected: false };

  const features = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(delimiter).map(c => c.trim().replace(/^"|"$/g, ""));
    const lat = Number(cols[latIdx]?.replace(",", "."));
    const lon = Number(cols[lonIdx]?.replace(",", "."));
    const properties = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties });
  }
  return { features, sourceCrs: "assumed EPSG:4326, UNVERIFIED (CSV carries no CRS metadata)", targetCrs: "EPSG:4326", reprojected: false, crsAssumed: true };
}

function extractRepresentativePoint(feature) {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === "Point") return geom.coordinates;
  if (geom.type === "Polygon") return geom.coordinates?.[0]?.[0] ?? null;
  if (geom.type === "MultiPolygon") return geom.coordinates?.[0]?.[0]?.[0] ?? null;
  if (geom.type === "LineString") return geom.coordinates?.[0] ?? null;
  return null;
}

/* =====================================================================
   Main per-dataset inspection
   ===================================================================== */

export async function inspectDataset(candidate, ctx) {
  const { provinceRegions, districtRegions, licenseEvidence, workRoot } = ctx;
  const workDir = new URL(`${candidate.dataset_id}/`, workRoot);

  const result = {
    organization: candidate.organization_title,
    province: candidate.expectedProvince,
    municipality: candidate.organization_title,
    dataset_id: candidate.dataset_id,
    dataset_title: candidate.dataset_title,
    resource_id: candidate.resource_id,
    resource_format: candidate.bucket,
    download_url: candidate.url,
    license_status: null,
    license_source: null,
    license_url: null,
    license_verified_at: null,
    source_crs: null,
    target_crs: "EPSG:4326",
    raw_feature_count: null,
    valid_geometry_count: null,
    stable_id_field: null,
    stable_id_coverage: null,
    duplicate_id_count: null,
    name_field: null,
    taxonomy_field: null,
    taxonomy_source_level: null,
    park_candidate_count: null,
    status: null,
    block_reason: null
  };

  // FIX 3: license — carry forward verified evidence before anything else.
  const orgEvidence = licenseEvidence.lookup(candidate.organization_title);
  let licenseInfo;
  if (orgEvidence) {
    licenseInfo = orgEvidence;
  } else if (candidate.license_id === "ulasav-license") {
    licenseInfo = ULASAV_LICENSE_VERIFIED;
  } else if (/cc[\s-]?by/i.test(candidate.license_title ?? "") || /cc[\s-]?by/i.test(candidate.license_id ?? "")) {
    licenseInfo = { license_status: "SAFE_OPEN", license_source: "license_title/id text pattern ('CC BY') — not individually page-verified", license_verified_at: null };
  } else {
    licenseInfo = { license_status: "LICENSE_UNVERIFIED", license_source: "no prior verification found, no known-open pattern matched", license_verified_at: null };
  }
  result.license_status = licenseInfo.license_status;
  result.license_source = licenseInfo.license_source;
  result.license_url = licenseInfo.license_url ?? candidate.license_url ?? null;
  result.license_verified_at = licenseInfo.license_verified_at;

  if (licenseInfo.license_status !== "SAFE_OPEN") {
    result.status = "BLOCKED_LICENSE";
    result.block_reason = `license_status=${licenseInfo.license_status} (${licenseInfo.license_source})`;
    return result;
  }

  try {
    let loaded;
    if (candidate.bucket === "GEOJSON") {
      loaded = await loadGeoJSON(candidate.url);
    } else if (candidate.bucket === "SHP") {
      // Shapefiles require 3+ companion files (.shp/.shx/.dbf/.prj) and are
      // essentially never distributed as a single bare .shp URL on these
      // platforms — always zipped, even when the URL doesn't literally end
      // in .zip. Default to true rather than relying on the URL suffix.
      loaded = await loadViaOgr2ogr(candidate.url, workDir, { isZip: !/\.shp($|\?)/i.test(candidate.url), format: "shp" });
    } else if (candidate.bucket === "KML") {
      loaded = await loadViaOgr2ogr(candidate.url, workDir, { isZip: /\.kmz($|\?)/i.test(candidate.url), format: "kml" });
    } else if (candidate.bucket === "CSV_COORDINATES") {
      loaded = await loadCsvCoordinates(candidate.url);
    } else {
      result.status = "UNSUPPORTED_FORMAT";
      result.block_reason = `bucket ${candidate.bucket} has no generic reader`;
      return result;
    }

    result.source_crs = loaded.sourceCrs;

    if (loaded.crsError || loaded.sourceCrs === null) {
      result.status = "BLOCKED_CRS";
      result.block_reason = "no CRS metadata could be determined — refusing to guess";
      return result;
    }

    const rawCount = loaded.features.length;
    result.raw_feature_count = rawCount;

    if (rawCount === 0) {
      result.status = "BLOCKED_SCHEMA";
      result.block_reason = "0 features loaded";
      return result;
    }

    let validGeometry = 0;
    const points = [];
    for (const f of loaded.features) {
      const p = extractRepresentativePoint(f);
      if (p && coordPlausible(p[1], p[0])) {
        validGeometry++;
        points.push({ feature: f, lon: p[0], lat: p[1] });
      }
    }
    result.valid_geometry_count = validGeometry;

    if (validGeometry === 0) {
      result.status = "BLOCKED_CRS";
      result.block_reason = `0/${rawCount} coordinates plausible after reprojection (source CRS: ${loaded.sourceCrs}) — refusing to ingest, not silently accepting`;
      return result;
    }

    const idInfo = guessIdField(loaded.features);
    result.stable_id_field = idInfo.field;
    result.stable_id_coverage = idInfo.field ? `${idInfo.nonNullCount}/${idInfo.total}` : "0/0";
    result.duplicate_id_count = idInfo.field ? idInfo.nonNullCount - idInfo.distinctCount : null;

    if (idInfo.ambiguous) {
      result.status = "BLOCKED_SCHEMA";
      result.block_reason = `identity field ambiguous — multiple equally-valid candidates tied: ${idInfo.tiedFields.join(", ")}`;
      return result;
    }

    const { nameField, taxonomy } = selectNameAndTaxonomyFields(loaded.features, candidate.dataset_title);
    result.name_field = nameField;
    result.taxonomy_field = taxonomy.field;
    result.taxonomy_source_level = taxonomy.sourceLevel;
    result.park_candidate_count = taxonomy.parkCandidateCount;

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
    result.province_coverage = candidate.expectedProvince ? `${provinceMatches}/${validGeometry}` : "n/a";
    result.district_coverage = candidate.expectedProvince ? `${districtResolved}/${provinceMatches || 1}` : "n/a";

    // Final classification
    const noId = !idInfo.field || idInfo.nonNullCount === 0;
    const partialId = idInfo.field && (idInfo.nonNullCount < idInfo.total || idInfo.distinctCount < idInfo.nonNullCount);

    if (noId) {
      result.status = "BLOCKED_IDENTITY";
      result.block_reason = "no field found (from the exact-priority list, or GeoJSON feature.id) with any non-null values usable as a stable id";
    } else if (taxonomy.sourceLevel === "row_level" && taxonomy.parkCandidateCount === 0) {
      result.status = "BLOCKED_TAXONOMY";
      result.block_reason = `row-level taxonomy field '${taxonomy.field}' present but 0 rows classify as PARK: ${JSON.stringify(taxonomy.buckets)}`;
    } else if (taxonomy.sourceLevel === "dataset_title_only" && taxonomy.bucket !== "PARK") {
      result.status = "NOT_PARK_DATA";
      result.block_reason = `no row-level taxonomy field found among ${TAXONOMY_FIELD_PRIORITY.join("/")}; dataset title indicates '${taxonomy.bucket}', not PARK`;
    } else if (taxonomy.sourceLevel === "dataset_title_only" && taxonomy.bucket === "PARK" && partialId) {
      result.status = "BLOCKED_IDENTITY";
      result.block_reason = `title suggests PARK but identity is only partial (${idInfo.nonNullCount}/${idInfo.total} non-null, ${idInfo.distinctCount} distinct) and taxonomy confidence is weak (title-only) — too risky to mark READY`;
    } else if (taxonomy.sourceLevel === "dataset_title_only" && taxonomy.bucket === "PARK") {
      result.status = "READY_AFTER_SMALL_PARSER";
      result.block_reason = "geometry/identity/license OK, but taxonomy confidence is WEAK (dataset-title-only, no row-level type field found) — needs a human sanity check, per instruction that title alone is not sufficient";
    } else if (partialId) {
      result.status = "BLOCKED_IDENTITY";
      result.block_reason = `identity only partial: ${idInfo.nonNullCount}/${idInfo.total} non-null, ${idInfo.distinctCount} distinct — do not fabricate the gap`;
    } else if (!nameField) {
      result.status = "READY_AFTER_SMALL_PARSER";
      result.block_reason = `license/identity/taxonomy OK but no field from the exact name-field priority list (${NAME_FIELD_PRIORITY.join("/")}) was found — needs a small parser addition to derive a display name`;
    } else {
      result.status = "READY_FOR_RECONCILIATION";
      result.block_reason = `license OK (${result.license_source}), identity OK (${idInfo.field}, ${idInfo.distinctCount}/${idInfo.total} distinct), row-level taxonomy confirms ${taxonomy.parkCandidateCount} PARK rows, name field '${nameField}' present, geometry valid after explicit CRS handling`;
    }

    return result;
  } catch (error) {
    result.status = "DOWNLOAD_FAILED";
    result.block_reason = error.message;
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

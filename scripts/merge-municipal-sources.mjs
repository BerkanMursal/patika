import { readFile, writeFile } from "node:fs/promises";
import { nameKey, distanceMeters } from "./park-enrichment.mjs";
import { loadProvinceRegions, officialProvinceNames } from "./province-boundaries.mjs";

// Generic municipal-adapter -> nationwide-canonical merge layer.
//
// Any municipal adapter (Konya, Ordu, and future ones) produces a preview
// in the same shape this script already understands: a `summary.sourceCode`,
// `matched[]`, `newCanonicalParks[]`, `review[]`, `rejectedNonPark[]`. This
// script reads that shape generically — it does not contain "if Konya" /
// "if Ordu" branches. Adding a third source later means adding one entry to
// MUNICIPAL_SOURCES below (declarative data, not new merge logic), as long
// as that source's adapter emits the same shape.
//
// Rules (see docs/PARK_DATA_CHECKPOINT.md for the full spec this implements):
//   MATCHED       -> attach source_ref to the existing canonical park.
//                    Never create a new park. Never change its id/osm_id/
//                    name/coordinates. Refuse if osm_id doesn't match
//                    exactly (would mean silently overwriting identity).
//   NEW_CANONICAL -> add as a new canonical park. Requires: unique id,
//                    >=1 source_ref, valid coordinate, non-empty city.
//                    District nullable only when the source genuinely has
//                    no district field (already encoded upstream, e.g.
//                    Ordu's district === "").
//   REVIEW        -> never added to canonical. Preserved in a combined
//                    review backlog artifact instead (never dropped).
//   REJECTED      -> never added anywhere.
//
// Read-only against the DB (never touches it) and against git (no commit).
// Writes only to data/park-enrichment/.cache/ (gitignored).

const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);

const nationwidePreviewPath =
  process.env.NATIONWIDE_CANONICAL_PREVIEW ||
  new URL("nationwide-canonical-preview.json", cacheRoot);

const outputPath =
  process.env.NATIONWIDE_CANONICAL_OUTPUT || nationwidePreviewPath;

const reviewBacklogPath = new URL("municipal-review-backlog.json", cacheRoot);
const mergeReportPath = new URL("municipal-merge-report.json", cacheRoot);

const provincesPath = new URL("../data/provinces.geojson", import.meta.url);
const provinceRegions = await loadProvinceRegions(provincesPath);
const officialProvinces = officialProvinceNames(provinceRegions);

// Declarative registry of adapter previews that are ready to merge. This is
// data, not one-off logic — every entry is handled by the exact same
// generic code path below.
const MUNICIPAL_SOURCES = [
  {
    sourceCode: "konya_acikveri_parklar",
    province: "Konya",
    // Corrected via the current generic engine (extended-radius review guard): 13573/13643 moved NEW -> REVIEW.
    previewPath: new URL("konya/konya_acikveri_parklar-generic-preview.json", cacheRoot)
  },
  {
    sourceCode: "ordu_acikveri_parklari",
    province: "Ordu",
    previewPath: new URL("ordu/ordu-canonical-preview.json", cacheRoot)
  },
  {
    sourceCode: "trabzon_acikveri_parklar",
    province: "Trabzon",
    previewPath: new URL("trabzon/trabzon-canonical-preview.json", cacheRoot)
  },
  {
    sourceCode: "kayseri_kocasinan_park_ve_bahceler",
    province: "Kayseri",
    previewPath: new URL("kayseri/kayseri_kocasinan_park_ve_bahceler-generic-preview.json", cacheRoot)
  },
  {
    sourceCode: "van_buyuksehir_parklar",
    province: "Van",
    previewPath: new URL("van/van_buyuksehir_parklar-generic-preview.json", cacheRoot)
  }
];

const nationwidePreview = JSON.parse(await readFile(nationwidePreviewPath, "utf8"));

if (nationwidePreview.mode !== "nationwide-canonical-preview") {
  throw new Error(`Unexpected dataset mode: ${nationwidePreview.mode}`);
}

const beforeCount = nationwidePreview.parks.length;
const beforeOsmBacked = nationwidePreview.parks.filter(p => p.osm_id).length;
const beforeIzmirMunicipalOnly = nationwidePreview.parks.filter(
  p => p.city === "İzmir" && !p.osm_id
).length;

/* -------------------------------------------------
   Generic adapter-shape normalization
------------------------------------------------- */

function normalizeAdapterPreview(sourceEntry, preview) {
  if (preview.summary.sourceCode !== sourceEntry.sourceCode) {
    throw new Error(
      `Preview sourceCode mismatch: expected ${sourceEntry.sourceCode}, got ${preview.summary.sourceCode}`
    );
  }

  return {
    source_code: preview.summary.sourceCode,
    province: sourceEntry.province,
    matched: preview.matched ?? [],
    new_canonical: preview.newCanonicalParks ?? [],
    review: preview.review ?? [],
    rejected: preview.rejectedNonPark ?? [],
    sourceRefsProducedClaimed:
      preview.summary.sourceRefsProduced ??
      (preview.matched?.length ?? 0) + (preview.newCanonicalParks?.length ?? 0)
  };
}

/* -------------------------------------------------
   Generic merge application
------------------------------------------------- */

function simpleSimilarity(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return null;
  if (x === y) return 1;

  // Cheap Levenshtein distance -> similarity ratio [0,1]. Good enough for a
  // review-triage hint; not used for any auto-merge decision.
  const dp = Array.from({ length: x.length + 1 }, (_, i) =>
    Array(y.length + 1).fill(0)
  );
  for (let i = 0; i <= x.length; i++) dp[i][0] = i;
  for (let j = 0; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i][j] =
        x[i - 1] === y[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  const distance = dp[x.length][y.length];
  return 1 - distance / Math.max(x.length, y.length);
}

function applyMunicipalResult(canonicalParks, parkById, result) {
  const appliedMatched = [];
  const appliedNew = [];
  const refsAdded = [];

  for (const m of result.matched) {
    const park = parkById.get(m.canonical_id);

    if (!park) {
      throw new Error(
        `[${result.source_code}] MATCHED canonical_id not found in nationwide baseline: ${m.canonical_id}`
      );
    }

    if (park.osm_id !== m.osm_id) {
      throw new Error(
        `[${result.source_code}] MATCHED osm_id mismatch for ${m.canonical_id}: ` +
          `baseline has ${park.osm_id}, adapter expected ${m.osm_id} — refusing to silently overwrite identity.`
      );
    }

    park.source_refs = park.source_refs ?? [];
    park.source_refs.push(m.source_ref);
    appliedMatched.push(m);
    refsAdded.push(m.source_ref);
  }

  for (const park of result.new_canonical) {
    if (parkById.has(park.id)) {
      throw new Error(
        `[${result.source_code}] NEW_CANONICAL id collides with an existing canonical park: ${park.id}`
      );
    }

    if (!park.source_refs?.length) {
      throw new Error(`[${result.source_code}] NEW_CANONICAL missing source_ref: ${park.id}`);
    }

    if (!Number.isFinite(park.latitude) || !Number.isFinite(park.longitude)) {
      throw new Error(`[${result.source_code}] NEW_CANONICAL missing a valid coordinate: ${park.id}`);
    }

    if (!park.city || !officialProvinces.has(park.city)) {
      throw new Error(
        `[${result.source_code}] NEW_CANONICAL missing/invalid province (must be one of the 81 official names): ${park.id} (${park.city})`
      );
    }

    // District nullable only when the source genuinely lacks one — already
    // encoded per-adapter (e.g. Ordu's candidate.district === "" because the
    // source has no district field at all). Never guessed here.
    if (park.district === undefined) {
      throw new Error(`[${result.source_code}] NEW_CANONICAL district field missing entirely: ${park.id}`);
    }

    canonicalParks.push(park);
    parkById.set(park.id, park);
    appliedNew.push(park);
    for (const ref of park.source_refs) refsAdded.push(ref);
  }

  return { appliedMatched, appliedNew, refsAdded };
}

/* -------------------------------------------------
   Review backlog enrichment — resolve osm candidate
   ids to real coordinates so distance/name-similarity
   are computed once here, generically, rather than
   trusting each adapter to have stored them.
------------------------------------------------- */

function enrichReviewRecord(entry, sourceCode, province, parkById) {
  const candidateCoord = {
    latitude: entry.candidate?.latitude,
    longitude: entry.candidate?.longitude
  };

  const rawOsmRefs = entry.osm_candidates ?? (entry.osm_candidate ? [entry.osm_candidate] : []);

  const osmCandidates = rawOsmRefs.map(ref => {
    const full = parkById.get(ref.id);
    const distance_m =
      full && Number.isFinite(candidateCoord.latitude) && Number.isFinite(candidateCoord.longitude)
        ? Math.round(distanceMeters(candidateCoord, full))
        : null;

    return {
      canonical_id: ref.id,
      osm_id: ref.osm_id,
      name: ref.name,
      distance_m,
      name_similarity: simpleSimilarity(entry.candidate?.name, ref.name)
    };
  });

  return {
    source_code: sourceCode,
    external_id: entry.candidate?.external_id ?? null,
    name: entry.candidate?.name ?? null,
    province,
    district: entry.candidate?.district ?? null,
    latitude: candidateCoord.latitude ?? null,
    longitude: candidateCoord.longitude ?? null,
    review_reason: entry.reason,
    osm_candidates: osmCandidates,
    other_candidates_targeting_same_park: entry.other_candidates_targeting_same_park ?? undefined,
    extended_radius_evidence: entry.extended_radius_evidence ?? undefined
  };
}

/* -------------------------------------------------
   Run the merge
------------------------------------------------- */

const canonicalParks = nationwidePreview.parks;
const parkById = new Map(canonicalParks.map(p => [p.id, p]));

// Idempotency: this script can be re-run after a new source is added to
// MUNICIPAL_SOURCES without re-applying sources already merged into the
// baseline (never re-fetches/re-runs an adapter — just reads its existing
// preview file again to keep the combined review/rejected backlog complete,
// and skips MATCHED/NEW_CANONICAL application for anything already present).
const alreadyMerged = new Set(nationwidePreview.summary.municipalSourcesMerged ?? []);
const priorSourceReports = new Map(
  (nationwidePreview.municipalMerge?.sources ?? []).map(r => [r.source_code, r])
);

const perSourceReport = [];
const combinedReviewBacklog = [];
const combinedRejected = [];

for (const sourceEntry of MUNICIPAL_SOURCES) {
  const rawPreview = JSON.parse(await readFile(sourceEntry.previewPath, "utf8"));
  const result = normalizeAdapterPreview(sourceEntry, rawPreview);
  const skip = alreadyMerged.has(result.source_code);

  const { appliedMatched, appliedNew, refsAdded } = skip
    ? { appliedMatched: [], appliedNew: [], refsAdded: [] }
    : applyMunicipalResult(canonicalParks, parkById, result);

  // Review/rejected are re-collected every run regardless of skip status —
  // rebuilding the combined backlog artifact from each source's still-
  // unchanged preview file is just a read, not redoing any adapter work.
  for (const entry of result.review) {
    combinedReviewBacklog.push(
      enrichReviewRecord(entry, result.source_code, result.province, parkById)
    );
  }

  for (const entry of result.rejected) {
    combinedRejected.push({ source_code: result.source_code, ...entry });
  }

  if (skip) {
    perSourceReport.push(
      priorSourceReports.get(result.source_code) ?? {
        source_code: result.source_code,
        province: result.province,
        matchedApplied: 0,
        newCanonicalApplied: 0,
        reviewPreserved: result.review.length,
        rejectedPreserved: result.rejected.length,
        sourceRefsAdded: 0,
        sourceRefsClaimedByAdapter: result.sourceRefsProducedClaimed,
        note: "already merged in an earlier run — not re-applied"
      }
    );
    continue;
  }

  perSourceReport.push({
    source_code: result.source_code,
    province: result.province,
    matchedApplied: appliedMatched.length,
    newCanonicalApplied: appliedNew.length,
    reviewPreserved: result.review.length,
    rejectedPreserved: result.rejected.length,
    sourceRefsAdded: refsAdded.length,
    sourceRefsClaimedByAdapter: result.sourceRefsProducedClaimed
  });

  if (refsAdded.length !== result.sourceRefsProducedClaimed) {
    throw new Error(
      `[${result.source_code}] source ref count mismatch: adapter claimed ${result.sourceRefsProducedClaimed}, merge applied ${refsAdded.length}`
    );
  }
}

/* -------------------------------------------------
   Full invariant re-check (mirrors
   build-nationwide-canonical.mjs's own invariant
   block — must still hold after the merge).
------------------------------------------------- */

const ids = new Set();
const osmIds = new Set();
const refs = new Map();
const invalidCoordinates = [];
const invalidProvinces = [];

for (const park of canonicalParks) {
  if (ids.has(park.id)) throw new Error(`Duplicate canonical id after merge: ${park.id}`);
  ids.add(park.id);

  if (park.osm_id) {
    if (osmIds.has(park.osm_id)) throw new Error(`Duplicate OSM id after merge: ${park.osm_id}`);
    osmIds.add(park.osm_id);
  }

  for (const ref of park.source_refs ?? []) {
    const key = `${ref.source_code}:${ref.external_id}`;
    if (refs.has(key)) {
      throw new Error(`Duplicate source ref ${key} after merge: ${refs.get(key)} and ${park.id}`);
    }
    refs.set(key, park.id);
  }

  if (
    !Number.isFinite(park.latitude) ||
    !Number.isFinite(park.longitude) ||
    park.latitude < 35 ||
    park.latitude > 43 ||
    park.longitude < 25 ||
    park.longitude > 45
  ) {
    invalidCoordinates.push(park.id);
  }

  if (!officialProvinces.has(park.city)) {
    invalidProvinces.push({ id: park.id, city: park.city });
  }
}

if (invalidProvinces.length) {
  throw new Error(`Province outside official 81-name registry after merge: ${JSON.stringify(invalidProvinces.slice(0, 10))}`);
}
if (invalidCoordinates.length) {
  throw new Error(`Invalid coordinates after merge: ${invalidCoordinates.slice(0, 10)}`);
}

/* -------------------------------------------------
   Cross-checks specific to this milestone
------------------------------------------------- */

const afterOsmBacked = canonicalParks.filter(p => p.osm_id).length;
const afterIzmirMunicipalOnly = canonicalParks.filter(p => p.city === "İzmir" && !p.osm_id).length;

const osmDeterministicIdChanges =
  afterOsmBacked === beforeOsmBacked
    ? 0
    : afterOsmBacked - beforeOsmBacked; // any drift here means an OSM-backed identity was altered, not just additions

const crossChecks = {
  osmBackedCountUnchanged: afterOsmBacked === beforeOsmBacked,
  osmBackedBefore: beforeOsmBacked,
  osmBackedAfter: afterOsmBacked,
  izmirMunicipalOnlyPreserved: afterIzmirMunicipalOnly === beforeIzmirMunicipalOnly,
  izmirMunicipalOnlyBefore: beforeIzmirMunicipalOnly,
  izmirMunicipalOnlyAfter: afterIzmirMunicipalOnly,
  osmDeterministicIdChanges
};

if (!crossChecks.osmBackedCountUnchanged) {
  throw new Error(
    `OSM-backed park count changed after merge (${beforeOsmBacked} -> ${afterOsmBacked}) — an OSM identity was altered, not just additions.`
  );
}
if (!crossChecks.izmirMunicipalOnlyPreserved) {
  throw new Error(
    `İzmir municipal-only park count changed after merge (${beforeIzmirMunicipalOnly} -> ${afterIzmirMunicipalOnly}) — municipal evidence was not preserved.`
  );
}

const totalNewCanonical = perSourceReport.reduce((sum, r) => sum + r.newCanonicalApplied, 0);
const totalMatched = perSourceReport.reduce((sum, r) => sum + r.matchedApplied, 0);
const totalReview = combinedReviewBacklog.length;

/* -------------------------------------------------
   Write outputs
------------------------------------------------- */

const byProvince = new Map();
for (const park of canonicalParks) {
  const key = park.city || "(atanmamış)";
  byProvince.set(key, (byProvince.get(key) ?? 0) + 1);
}

const summary = {
  ...nationwidePreview.summary,
  totalCanonicalParks: canonicalParks.length,
  osmBackedParks: afterOsmBacked,
  municipalOnlyParks: canonicalParks.length - afterOsmBacked,
  totalSourceRefs: refs.size,
  distinctProvinceCount: byProvince.size,
  duplicateCanonicalIds: 0,
  duplicateOsmIds: 0,
  duplicateSourceRefs: 0,
  invalidCoordinates: 0,
  invalidProvinces: 0,
  municipalSourcesMerged: perSourceReport.map(r => r.source_code)
};

const mergedOutput = {
  ...nationwidePreview,
  generatedAt: new Date().toISOString(),
  mode: "nationwide-canonical-preview",
  summary,
  parks: canonicalParks,
  municipalMerge: {
    mergedAt: new Date().toISOString(),
    sources: perSourceReport
  }
};

await writeFile(outputPath, JSON.stringify(mergedOutput));

await writeFile(
  reviewBacklogPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: "municipal-review-backlog",
      totalRecords: combinedReviewBacklog.length,
      bySource: Object.fromEntries(
        MUNICIPAL_SOURCES.map(s => [
          s.sourceCode,
          combinedReviewBacklog.filter(r => r.source_code === s.sourceCode).length
        ])
      ),
      byReason: Object.fromEntries(
        [...new Set(combinedReviewBacklog.map(r => r.review_reason))].map(reason => [
          reason,
          combinedReviewBacklog.filter(r => r.review_reason === reason).length
        ])
      ),
      records: combinedReviewBacklog
    },
    null,
    2
  )
);

const mergeReport = {
  generatedAt: new Date().toISOString(),
  mode: "municipal-merge-report",
  nationwideCanonicalBefore: beforeCount,
  nationwideCanonicalAfter: canonicalParks.length,
  totalSafeNewCanonical: totalNewCanonical,
  totalMatched: totalMatched,
  totalReviewPreserved: totalReview,
  totalRejected: combinedRejected.length,
  perSource: perSourceReport,
  invariants: {
    duplicate_canonical_id: 0,
    duplicate_osm_id: 0,
    duplicate_source_code_plus_external_id: 0,
    invalid_canonical_coordinate: invalidCoordinates.length,
    province_outside_81_registry: invalidProvinces.length,
    osm_deterministic_id_changes: osmDeterministicIdChanges
  },
  crossChecks
};

await writeFile(mergeReportPath, JSON.stringify(mergeReport, null, 2));

console.log("===== MUNICIPAL MERGE =====");
console.log(mergeReport);
console.log(`\nSaved merged nationwide preview -> ${outputPath}`);
console.log(`Saved review backlog -> ${reviewBacklogPath}`);
console.log(`Saved merge report -> ${mergeReportPath}`);

import { readFile, writeFile } from "node:fs/promises";
import { nameKey } from "./park-enrichment.mjs";
import { loadNationwideOsmSource } from "./nationwide-osm-source.mjs";

// İzmir V2 (scripts/build-izmir-canonical-v2.mjs) is the verified municipal
// reconciliation — 1979 parks, 44 safe name upgrades — but it is frozen to
// whatever OSM snapshot existed when it last ran. Feeding a fresh nationwide
// OSM refresh into the canonical builder while still substituting İzmir
// wholesale with that frozen file silently drops every fresh İzmir OSM park
// that isn't already in it (and silently keeps every stale one that isn't in
// the fresh snapshot anymore). This script re-derives İzmir's OSM-backed set
// from the fresh baseline and re-attaches the frozen file's municipal
// evidence (source refs, name upgrades, review/unresolved context) by
// osm_id — never the other way around.
const izmirV2Path =
  process.env.IZMIR_CANONICAL_V2 ||
  new URL(
    "../data/park-enrichment/.cache/izmir-canonical-v2.json",
    import.meta.url
  );

const outputPath =
  process.env.IZMIR_CANONICAL_RECONCILED_OUTPUT ||
  new URL(
    "../data/park-enrichment/.cache/izmir-canonical-reconciled.json",
    import.meta.url
  );

function isUnnamed(name) {
  return !name?.trim() || nameKey(name) === nameKey("İsimsiz park");
}

let izmirV2;

try {
  izmirV2 = JSON.parse(await readFile(izmirV2Path, "utf8"));
} catch (error) {
  if (error.code === "ENOENT") {
    throw new Error(
      "İzmir canonical V2 cache bulunamadı. Municipal evidence olmadan " +
        "reconciliation yapılamaz — önce mevcut İzmir pipeline'ını " +
        "(download-izmir-official-parks.mjs -> ... -> build-izmir-canonical-v2.mjs) çalıştırın."
    );
  }
  throw error;
}

if (izmirV2.mode !== "canonical-v2-preview") {
  throw new Error(`Unexpected İzmir dataset mode: ${izmirV2.mode}`);
}

const { rows: osmRows, label: osmSourceLabel } = await loadNationwideOsmSource();

const freshIzmirRows = osmRows.filter(row => row[3] === "İzmir");
const freshByOsmId = new Map(freshIzmirRows.map(row => [row[1], row]));

const frozenOsmBacked = izmirV2.parks.filter(p => p.osm_id);
const frozenMunicipalOnly = izmirV2.parks.filter(p => !p.osm_id);
const frozenByOsmId = new Map(frozenOsmBacked.map(p => [p.osm_id, p]));

const freshOsmIds = new Set(freshByOsmId.keys());
const frozenOsmIds = new Set(frozenByOsmId.keys());

const commonOsmIds = [...freshOsmIds].filter(id => frozenOsmIds.has(id));
const newOsmIds = [...freshOsmIds].filter(id => !frozenOsmIds.has(id));
const removedOsmIds = [...frozenOsmIds].filter(id => !freshOsmIds.has(id));

/* -------------------------------------------------
   Common osm_ids: fresh coordinates/tags, frozen
   municipal evidence re-attached by osm_id.
------------------------------------------------- */

const reconciledCommon = [];
const nameUpgradeReapplied = [];
const nameUpgradeSuperseded = [];

for (const osmId of commonOsmIds) {
  const [id, , freshName, city, district, latitude, longitude] = freshByOsmId.get(osmId);
  const frozen = frozenByOsmId.get(osmId);

  const municipalRefs = (frozen.source_refs ?? []).filter(
    ref => ref.source_code !== "osm"
  );

  const park = {
    id,
    osm_id: osmId,
    name: freshName,
    city,
    district,
    latitude,
    longitude,
    source_refs: [
      { source_code: "osm", external_id: osmId, source_url: `https://www.openstreetmap.org/${osmId}` },
      ...municipalRefs
    ]
  };

  if (frozen.name_status === "municipal") {
    if (isUnnamed(freshName)) {
      // Fresh OSM still has no specific name of its own — the municipal
      // upgrade evidence still applies exactly as it did in V2.
      park.name = frozen.name;
      park.name_status = frozen.name_status;
      park.name_source = frozen.name_source;
      park.name_source_url = frozen.name_source_url;
      nameUpgradeReapplied.push({ osm_id: osmId, name: frozen.name });
    } else {
      // Fresh OSM now carries its own specific name — newer primary
      // evidence than the municipal upgrade; keep the OSM name.
      nameUpgradeSuperseded.push({
        osm_id: osmId,
        municipal_name: frozen.name,
        fresh_osm_name: freshName
      });
    }
  }

  reconciledCommon.push(park);
}

/* -------------------------------------------------
   New osm_ids: plain OSM canonical, no municipal
   evidence yet (never audited against the official
   source).
------------------------------------------------- */

const reconciledNew = newOsmIds.map(osmId => {
  const [id, , name, city, district, latitude, longitude] = freshByOsmId.get(osmId);

  return {
    id,
    osm_id: osmId,
    name,
    city,
    district,
    latitude,
    longitude,
    source_refs: [
      { source_code: "osm", external_id: osmId, source_url: `https://www.openstreetmap.org/${osmId}` }
    ]
  };
});

/* -------------------------------------------------
   Removed osm_ids: excluded from canonical (the OSM
   object no longer exists in the fresh snapshot), but
   never silently dropped — every one is audited, and
   any with municipal evidence attached goes to review
   instead of being discarded.
------------------------------------------------- */

const removedLifecycleAudit = [];
const review = [...(izmirV2.review ?? [])];

for (const osmId of removedOsmIds) {
  const frozen = frozenByOsmId.get(osmId);
  const municipalRefs = (frozen.source_refs ?? []).filter(
    ref => ref.source_code !== "osm"
  );

  const entry = {
    osm_id: osmId,
    name: frozen.name,
    name_status: frozen.name_status ?? "source",
    official_objectids: frozen.official_objectids ?? [],
    municipal_source_refs: municipalRefs
  };

  removedLifecycleAudit.push(entry);

  if (municipalRefs.length) {
    review.push({
      reason: "orphaned_municipal_evidence_osm_removed",
      ...entry
    });
  }
}

/* -------------------------------------------------
   Assemble + invariants
------------------------------------------------- */

const parks = [
  ...reconciledCommon,
  ...reconciledNew,
  ...frozenMunicipalOnly.map(park => ({ ...park }))
];

const ids = new Set();
const osmIds = new Set();
const refs = new Map();

for (const park of parks) {
  if (ids.has(park.id)) throw new Error(`Duplicate canonical id: ${park.id}`);
  ids.add(park.id);

  if (park.osm_id) {
    if (osmIds.has(park.osm_id)) throw new Error(`Duplicate OSM id: ${park.osm_id}`);
    osmIds.add(park.osm_id);
  }

  for (const ref of park.source_refs ?? []) {
    const key = `${ref.source_code}:${ref.external_id}`;
    if (refs.has(key)) {
      throw new Error(`Duplicate source ref ${key}: ${refs.get(key)} and ${park.id}`);
    }
    refs.set(key, park.id);
  }
}

// Same osm_id must always resolve to the same deterministic canonical id —
// verified directly against the frozen V2 file, which used the identical
// sha256("patika-osm:"+osm_id) formula.
const idMismatches = [];
for (const osmId of commonOsmIds) {
  const fresh = freshByOsmId.get(osmId)[0];
  const frozen = frozenByOsmId.get(osmId).id;
  if (fresh !== frozen) idMismatches.push({ osm_id: osmId, fresh_id: fresh, frozen_id: frozen });
}
if (idMismatches.length) {
  throw new Error(`Deterministic ID mismatch: ${JSON.stringify(idMismatches.slice(0, 5))}`);
}

const summary = {
  osmSource: osmSourceLabel,
  freshIzmirOsmCount: freshOsmIds.size,
  frozenIzmirOsmCount: frozenOsmIds.size,
  commonOsmIds: commonOsmIds.length,
  newOsmIds: newOsmIds.length,
  removedOsmIds: removedOsmIds.length,
  removedWithMunicipalEvidence: removedLifecycleAudit.filter(r => r.municipal_source_refs.length)
    .length,
  removedWithoutEvidence: removedLifecycleAudit.filter(r => !r.municipal_source_refs.length)
    .length,
  municipalOnlyCanonicalParks: frozenMunicipalOnly.length,
  totalCanonicalParks: parks.length,
  totalOsmBackedParks: reconciledCommon.length + reconciledNew.length,
  nameUpgradesTotal: izmirV2.safeNameUpgrades?.length ?? 0,
  nameUpgradesReapplied: nameUpgradeReapplied.length,
  nameUpgradesSupersededByFreshOsmName: nameUpgradeSuperseded.length,
  nameUpgradesLostToRemoval: removedLifecycleAudit.filter(
    r => r.name_status === "municipal"
  ).length,
  duplicateCanonicalIds: 0,
  duplicateOsmIds: 0,
  duplicateSourceRefs: 0,
  deterministicIdMismatches: 0
};

// Invariant: OSM-backed canonical count must equal the fresh baseline count
// for İzmir exactly — nothing quarantined without an explicit audit entry.
if (summary.totalOsmBackedParks !== summary.freshIzmirOsmCount) {
  throw new Error(
    `İzmir OSM-backed reconciliation mismatch: canonical=${summary.totalOsmBackedParks}, fresh=${summary.freshIzmirOsmCount}`
  );
}

const output = {
  generatedAt: new Date().toISOString(),
  mode: "izmir-canonical-reconciled",
  osmSource: osmSourceLabel,
  frozenSource: String(izmirV2Path),
  summary,
  parks,
  removedLifecycleAudit,
  nameUpgradeReapplied,
  nameUpgradeSuperseded,
  review,
  unresolved: izmirV2.unresolved ?? []
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("===== İZMİR CANONICAL RECONCILED =====");
console.log(summary);
console.log(`\nSaved -> ${outputPath}`);

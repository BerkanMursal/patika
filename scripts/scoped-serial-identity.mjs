import { distanceMeters } from "./park-enrichment.mjs";
import { pointInPolygonRings } from "./polygon-geometry.mjs";
import { strongNameEvidence } from "./name-evidence.mjs";

// Generic SOURCE-SCOPED SERIAL IDENTITY policy.
//
// Source record identity (never physical-park identity — canonical
// reconciliation stays separate):
//   RESOURCE scope (default): (source_code, package_uuid, resource_uuid, serial)
//   PACKAGE  scope (only when package-wide uniqueness is proven):
//                             (source_code, package_uuid, serial)
// Never derived from name, coordinates, row index, parser FIDs or any mutable
// feature content. All components stay separately readable for provenance and
// the single-string external_id is reversible (no hashing).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SERIAL_SCOPES = Object.freeze({ RESOURCE: "RESOURCE", PACKAGE: "PACKAGE" });

/* -------------------------------------------------
   Encoding — reversible, deterministic
   RESOURCE:  <package_uuid>/<resource_uuid>/<serial>
   PACKAGE :  <package_uuid>/<serial>
   serial is percent-encoded so a "/" inside a serial can never shift parts.
------------------------------------------------- */
export function encodeScopedSerialId({ package_uuid, resource_uuid, serial, serial_scope = SERIAL_SCOPES.RESOURCE }) {
  if (!UUID.test(package_uuid ?? "")) throw new Error(`scoped serial id: invalid package_uuid ${package_uuid}`);
  if (serial === null || serial === undefined || String(serial).trim() === "") throw new Error("scoped serial id: serial missing");
  const s = encodeURIComponent(String(serial).trim());
  if (serial_scope === SERIAL_SCOPES.PACKAGE) return `${package_uuid.toLowerCase()}/${s}`;
  if (serial_scope !== SERIAL_SCOPES.RESOURCE) throw new Error(`scoped serial id: unknown scope ${serial_scope}`);
  if (!UUID.test(resource_uuid ?? "")) throw new Error(`scoped serial id: invalid resource_uuid ${resource_uuid}`);
  return `${package_uuid.toLowerCase()}/${resource_uuid.toLowerCase()}/${s}`;
}

export function decodeScopedSerialId(externalId) {
  const parts = String(externalId).split("/");
  if (parts.length === 3 && UUID.test(parts[0]) && UUID.test(parts[1])) {
    return { serial_scope: SERIAL_SCOPES.RESOURCE, package_uuid: parts[0], resource_uuid: parts[1], serial: decodeURIComponent(parts[2]) };
  }
  if (parts.length === 2 && UUID.test(parts[0])) {
    return { serial_scope: SERIAL_SCOPES.PACKAGE, package_uuid: parts[0], resource_uuid: null, serial: decodeURIComponent(parts[1]) };
  }
  throw new Error(`not a scoped serial id: ${externalId}`);
}

// source_ref with the components kept separately next to the encoded string.
export function toSourceRef({ source_code, package_uuid, resource_uuid, serial, serial_scope = SERIAL_SCOPES.RESOURCE, source_url }) {
  return {
    source_code,
    external_id: encodeScopedSerialId({ package_uuid, resource_uuid, serial, serial_scope }),
    source_url: source_url ?? null,
    identity: { policy: "source_scoped_serial", serial_scope, package_uuid: package_uuid.toLowerCase(), resource_uuid: resource_uuid ? resource_uuid.toLowerCase() : null, serial: String(serial).trim() }
  };
}

/* -------------------------------------------------
   Placeholder names: identity may be valid, but the name is not semantic
   evidence ("12", "PARK 4").
------------------------------------------------- */
export function isPlaceholderName(name) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  return n === "" || /^\d+$/.test(n) || /^park\s*\d+$/i.test(n);
}

/* -------------------------------------------------
   Companion-table join validation
------------------------------------------------- */
export function validateCompanionJoin(featureSerials, tableSerials, { min_join_coverage = 0.95 } = {}) {
  const feat = featureSerials.map(String);
  const table = tableSerials.map(String);
  const tableSet = new Set(table);
  const featSet = new Set(feat);
  const joined = feat.filter(s => tableSet.has(s));
  const dupFeature = feat.length - featSet.size;
  const dupTable = table.length - tableSet.size;
  const coverage = feat.length ? joined.length / feat.length : 0;
  return {
    feature_count: feat.length,
    serial_count: featSet.size,
    table_rows: table.length,
    joined_count: joined.length,
    join_coverage: Math.round(coverage * 10000) / 10000,
    duplicate_serials: dupFeature,
    duplicate_table_serials: dupTable,
    missing_serials: feat.filter(s => !tableSet.has(s)),
    orphan_table_rows: [...tableSet].filter(s => !featSet.has(s)),
    passes: feat.length > 0 && coverage >= min_join_coverage && dupFeature === 0
  };
}

/* -------------------------------------------------
   Snapshot comparison (per resource-scoped serial)
   snapshot = { resources: { [package_uuid]: { [resource_uuid]: { serials: { [serial]: {name, latitude, longitude} } } } } }
------------------------------------------------- */
const DEFAULTS = {
  attribute_tolerance_m: 50,       // moved less than this = normal edit
  reuse_distance_m: 200,           // same serial > this away (or clearly different name) = reused
  remap_match_m: 10,               // current point equals another serial's previous point within this = remapped
  mass_renumbering_fraction: 0.2,  // >= this fraction of a resource remapped = mass renumbering
  max_serial_reused: 0
};

export function compareSnapshots(prev, curr, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const allowed = new Set((o.allowed_migrations ?? []).map(String));
  const records = [];
  const flags = { RESOURCE_REPLACED: [], RESOURCE_MOVED: [], MASS_RENUMBERING: [] };

  const prevPk = prev.resources ?? {};
  const currPk = curr.resources ?? {};

  for (const pkg of Object.keys({ ...prevPk, ...currPk })) {
    const pRes = prevPk[pkg] ?? {};
    const cRes = currPk[pkg] ?? {};
    const gone = Object.keys(pRes).filter(r => !(r in cRes));
    const added = Object.keys(cRes).filter(r => !(r in pRes));
    if (gone.length && added.length) {
      for (const g of gone) if (!allowed.has(`${pkg}/${g}`)) flags.RESOURCE_REPLACED.push({ package_uuid: pkg, old_resource_uuid: g, new_resource_uuids: added });
    }
    // serial moved to another resource in the same package with same name+place
    for (const g of gone.concat(Object.keys(pRes).filter(r => r in cRes))) {
      for (const [serial, rec] of Object.entries(pRes[g]?.serials ?? {})) {
        if (g in cRes && serial in (cRes[g].serials ?? {})) continue;
        for (const other of Object.keys(cRes)) {
          if (other === g) continue;
          const hit = cRes[other].serials?.[serial];
          if (hit && close(rec, hit, o.remap_match_m)) flags.RESOURCE_MOVED.push({ package_uuid: pkg, serial, from_resource_uuid: g, to_resource_uuid: other });
        }
      }
    }

    for (const res of Object.keys(pRes)) {
      if (!(res in cRes)) continue;
      const pS = pRes[res].serials ?? {};
      const cS = cRes[res].serials ?? {};
      let remapped = 0;
      for (const [serial, cur] of Object.entries(cS)) {
        const before = pS[serial];
        let status;
        if (!before) status = "ADDED";
        else if (same(before, cur, o)) status = "UNCHANGED";
        else {
          const distM = pointDistance(before, cur);
          const remap = Object.entries(pS).some(([s2, r2]) => s2 !== serial && close(r2, cur, o.remap_match_m));
          if (remap) { status = "REMAPPED"; remapped++; }
          else if (distM !== null && distM > o.reuse_distance_m) status = "SERIAL_REUSED";
          else status = "NORMAL_ATTRIBUTE_CHANGE";
        }
        records.push({ package_uuid: pkg, resource_uuid: res, serial, status });
      }
      for (const serial of Object.keys(pS)) if (!(serial in cS)) records.push({ package_uuid: pkg, resource_uuid: res, serial, status: "REMOVED" });
      const total = Math.max(Object.keys(cS).length, 1);
      if (remapped / total >= o.mass_renumbering_fraction && remapped > 0) flags.MASS_RENUMBERING.push({ package_uuid: pkg, resource_uuid: res, remapped, total });
    }
  }

  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const reused = counts.SERIAL_REUSED ?? 0;
  const blockers = [];
  if (flags.MASS_RENUMBERING.length) blockers.push("MASS_RENUMBERING");
  if (reused > o.max_serial_reused) blockers.push("SERIAL_REUSED");
  if (flags.RESOURCE_REPLACED.length) blockers.push("RESOURCE_REPLACED");
  if (flags.RESOURCE_MOVED.length) blockers.push("RESOURCE_MOVED");
  return { counts, flags, blockers, blocked: blockers.length > 0, records };
}

// Restrict a comparison result to one resource so a renumbering in resource X
// blocks only X (source-level policy can still choose to block everything).
export function comparisonForResource(comparison, resource_uuid, options = {}) {
  if (!comparison) return null;
  const o = { ...DEFAULTS, ...options };
  const records = comparison.records.filter(r => r.resource_uuid === resource_uuid);
  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const flags = {
    RESOURCE_REPLACED: comparison.flags.RESOURCE_REPLACED.filter(f => f.old_resource_uuid === resource_uuid),
    RESOURCE_MOVED: comparison.flags.RESOURCE_MOVED.filter(f => f.from_resource_uuid === resource_uuid || f.to_resource_uuid === resource_uuid),
    MASS_RENUMBERING: comparison.flags.MASS_RENUMBERING.filter(f => f.resource_uuid === resource_uuid)
  };
  const blockers = [];
  if (flags.MASS_RENUMBERING.length) blockers.push("MASS_RENUMBERING");
  if ((counts.SERIAL_REUSED ?? 0) > o.max_serial_reused) blockers.push("SERIAL_REUSED");
  if (flags.RESOURCE_REPLACED.length) blockers.push("RESOURCE_REPLACED");
  if (flags.RESOURCE_MOVED.length) blockers.push("RESOURCE_MOVED");
  return { counts, flags, blockers, blocked: blockers.length > 0, records };
}

function pointDistance(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null;
  return distanceMeters(a, b);
}
function close(a, b, m) { const d = pointDistance(a, b); return d !== null && d <= m; }
function same(a, b, o) {
  if ((a.name ?? "") !== (b.name ?? "")) return false;
  const d = pointDistance(a, b);
  return d === null ? (a.latitude ?? null) === (b.latitude ?? null) : d <= 0.5;
}

/* -------------------------------------------------
   Cross-resource near-duplicate guard (REVIEW only, never merges)
   record = { key, resource_uuid, name, latitude, longitude, polygon? }
------------------------------------------------- */
export function crossResourceNearDuplicates(records, { close_m = 30, strong_name_m = 150 } = {}) {
  const pairs = [];
  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    if (!Number.isFinite(a.latitude)) continue;
    for (let j = i + 1; j < records.length; j++) {
      const b = records[j];
      if (a.resource_uuid === b.resource_uuid || !Number.isFinite(b.latitude)) continue;
      const d = distanceMeters(a, b);
      const reasons = [];
      if (d <= close_m) reasons.push("very_close");
      if (d <= strong_name_m && !isPlaceholderName(a.name) && !isPlaceholderName(b.name) && strongNameEvidence(a.name, b.name)) reasons.push("strong_name_nearby");
      if (a.polygon && pointInPolygonRings(b.longitude, b.latitude, a.polygon)) reasons.push("point_inside_other_polygon");
      if (b.polygon && pointInPolygonRings(a.longitude, a.latitude, b.polygon)) reasons.push("point_inside_other_polygon");
      if (reasons.length) pairs.push({ a: a.key, b: b.key, a_name: a.name, b_name: b.name, distance_m: Math.round(d * 10) / 10, reasons: [...new Set(reasons)], review_reason: "cross_resource_near_duplicate" });
    }
  }
  return pairs;
}

/* -------------------------------------------------
   Package-scope proof: allowed ONLY if every geo resource the upstream
   package lists was loaded and the serial union is globally unique.
------------------------------------------------- */
export function packageScopeProof({ upstream_geo_resource_uuids, loaded }) {
  // loaded: { [resource_uuid]: string[] serials }
  const missing = upstream_geo_resource_uuids.filter(r => !(r in loaded));
  if (missing.length) return { proven: false, reason: "upstream_geo_resources_not_loaded", unchecked_resources: missing };
  const all = Object.values(loaded).flat().map(String);
  const uniq = new Set(all);
  if (all.length !== uniq.size) return { proven: false, reason: "serial_collision_across_resources", collisions: all.length - uniq.size };
  return { proven: true, reason: "all_upstream_geo_resources_checked_and_serials_unique", resources: upstream_geo_resource_uuids.length, serials: all.length };
}

/* -------------------------------------------------
   Fail-closed dataset (resource) validation — checks A..I
------------------------------------------------- */
export function validateScopedSerialResource(input, config = {}) {
  const {
    package_uuid, resource_uuid, records, serial_scope = SERIAL_SCOPES.RESOURCE,
    companion_join = null, snapshot_comparison = null, resource_state = null, license_status = null
  } = input;
  const cfg = { min_serial_coverage: 1.0, min_join_coverage: 0.95, require_companion_join: true, ...config };
  const checks = [];
  const add = (id, name, pass, detail = null, kind = "BLOCKED_IDENTITY") => checks.push({ id, name, pass: !!pass, detail, blocks_as: pass ? null : kind });

  const total = records.length;
  const withSerial = records.filter(r => r.serial !== null && r.serial !== undefined && String(r.serial).trim() !== "");
  add("A", "serial_present", total > 0 && withSerial.length / total >= cfg.min_serial_coverage, { features: total, with_serial: withSerial.length, coverage: total ? withSerial.length / total : 0, required: cfg.min_serial_coverage });

  const seen = new Map();
  for (const r of withSerial) seen.set(String(r.serial).trim(), (seen.get(String(r.serial).trim()) ?? 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  add("B", "serial_unique_in_scope", dups.length === 0, { duplicate_serials: dups.slice(0, 10), duplicate_count: dups.length });
  add("C", "package_uuid_present", UUID.test(package_uuid ?? ""), { package_uuid });
  add("D", "resource_uuid_present", serial_scope === SERIAL_SCOPES.PACKAGE ? true : UUID.test(resource_uuid ?? ""), { resource_uuid, scope: serial_scope });
  if (cfg.require_companion_join) add("E", "companion_join_coverage", !!companion_join && companion_join.passes && companion_join.join_coverage >= cfg.min_join_coverage, companion_join ? { join_coverage: companion_join.join_coverage, missing: companion_join.missing_serials.length, orphans: companion_join.orphan_table_rows.length, threshold: cfg.min_join_coverage } : { reason: "no_companion_table_configured_or_found" });
  add("F", "no_unexpected_renumbering", !snapshot_comparison || !snapshot_comparison.blocked, snapshot_comparison ? { blockers: snapshot_comparison.blockers, counts: snapshot_comparison.counts } : { note: "no_previous_snapshot_first_ingest" });
  // G: the encoded identities themselves must be unique/constructible
  let g = true, gDetail = null;
  try { const enc = withSerial.map(r => encodeScopedSerialId({ package_uuid, resource_uuid, serial: r.serial, serial_scope })); g = new Set(enc).size === enc.length; } catch (e) { g = false; gDetail = e.message; }
  add("G", "no_duplicate_scoped_identity", g, gDetail);
  add("H", "resource_not_silently_replaced", !resource_state || resource_state.replaced !== true, resource_state ?? { note: "no_previous_resource_state" });
  add("I", "license_safe_open", license_status === "SAFE_OPEN", { license_status }, "BLOCKED_LICENSE");

  const identityFail = checks.filter(c => !c.pass && c.blocks_as === "BLOCKED_IDENTITY");
  const licenseFail = checks.filter(c => !c.pass && c.blocks_as === "BLOCKED_LICENSE");
  const status = identityFail.length ? "BLOCKED_IDENTITY" : licenseFail.length ? "BLOCKED_LICENSE" : "READY_FOR_RECONCILIATION";
  return { status, identity_valid: identityFail.length === 0, checks, failed: [...identityFail, ...licenseFail].map(c => c.id) };
}

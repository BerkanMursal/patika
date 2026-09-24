import assert from "node:assert/strict";
import {
  encodeScopedSerialId, decodeScopedSerialId, toSourceRef, isPlaceholderName, validateCompanionJoin,
  compareSnapshots, comparisonForResource, crossResourceNearDuplicates, packageScopeProof, validateScopedSerialResource
} from "./scoped-serial-identity.mjs";

// Self-test for the generic scoped-serial identity policy. Run: node scripts/test-scoped-serial-identity.mjs
const P = "76f80952-9ee0-47ae-8092-4f36e46cfe3e";
const R = "09e46371-273a-4ef4-be36-b7f34c3ad892";
const R2 = "11111111-2222-4333-8444-555555555555";

// encode/decode is reversible, deterministic, scope-aware, and never hashes
const id = encodeScopedSerialId({ package_uuid: P, resource_uuid: R, serial: "12" });
assert.equal(id, `${P}/${R}/12`);
assert.deepEqual(decodeScopedSerialId(id), { serial_scope: "RESOURCE", package_uuid: P, resource_uuid: R, serial: "12" });
const pid = encodeScopedSerialId({ package_uuid: P, serial: "12", serial_scope: "PACKAGE" });
assert.deepEqual(decodeScopedSerialId(pid), { serial_scope: "PACKAGE", package_uuid: P, resource_uuid: null, serial: "12" });
assert.equal(decodeScopedSerialId(encodeScopedSerialId({ package_uuid: P, resource_uuid: R, serial: "A/B 1" })).serial, "A/B 1");
assert.throws(() => encodeScopedSerialId({ package_uuid: P, resource_uuid: R, serial: "" }));
assert.throws(() => encodeScopedSerialId({ package_uuid: "nope", resource_uuid: R, serial: "1" }));
assert.throws(() => encodeScopedSerialId({ package_uuid: P, resource_uuid: null, serial: "1" }));
const ref = toSourceRef({ source_code: "x", package_uuid: P, resource_uuid: R, serial: 7 });
assert.equal(ref.identity.serial, "7"); assert.equal(ref.identity.resource_uuid, R);
// same serial in another resource is a DIFFERENT identity under RESOURCE scope
assert.notEqual(id, encodeScopedSerialId({ package_uuid: P, resource_uuid: R2, serial: "12" }));

// placeholder names
for (const n of ["12", "PARK 4", "park  17", "", null]) assert.ok(isPlaceholderName(n), String(n));
for (const n of ["Kent Parkı", "PARK 1 Muhtarlık Çevresi"]) assert.ok(!isPlaceholderName(n), n);

// companion join
const j = validateCompanionJoin(["1", "2", "3", "4"], ["1", "2", "3", "9"], { min_join_coverage: 0.7 });
assert.equal(j.joined_count, 3); assert.deepEqual(j.missing_serials, ["4"]); assert.deepEqual(j.orphan_table_rows, ["9"]); assert.ok(j.passes);
assert.ok(!validateCompanionJoin(["1", "2"], ["1"], { min_join_coverage: 0.9 }).passes);
assert.ok(!validateCompanionJoin(["1", "1"], ["1"]).passes, "duplicate feature serial must fail");

// snapshot comparison
const snap = (recs, res = R) => ({ resources: { [P]: { [res]: { serials: recs } } } });
const base = snap({ 1: { name: "A", latitude: 38.0, longitude: 27.0 }, 2: { name: "B", latitude: 38.001, longitude: 27.001 }, 3: { name: "C", latitude: 38.002, longitude: 27.002 }, 4: { name: "D", latitude: 38.003, longitude: 27.003 } });
let c = compareSnapshots(base, base); assert.equal(c.counts.UNCHANGED, 4); assert.ok(!c.blocked);
c = compareSnapshots(base, snap({ ...base.resources[P][R].serials, 1: { name: "A renamed", latitude: 38.00001, longitude: 27.0 } }));
assert.equal(c.counts.NORMAL_ATTRIBUTE_CHANGE, 1); assert.ok(!c.blocked, "minor edits must not block");
c = compareSnapshots(base, snap({ ...base.resources[P][R].serials, 2: { name: "Z", latitude: 39.5, longitude: 28.5 } }));
assert.equal(c.counts.SERIAL_REUSED, 1); assert.ok(c.blocked && c.blockers.includes("SERIAL_REUSED"));
// mass renumbering: every serial shifted by one
const shifted = snap({ 1: base.resources[P][R].serials[2], 2: base.resources[P][R].serials[3], 3: base.resources[P][R].serials[4], 4: base.resources[P][R].serials[1] });
c = compareSnapshots(base, shifted); assert.ok(c.blockers.includes("MASS_RENUMBERING"), JSON.stringify(c.counts));
// resource replaced (new resource uuid, old gone) and moved serials
c = compareSnapshots(base, snap(base.resources[P][R].serials, R2)); assert.ok(c.blockers.includes("RESOURCE_REPLACED"));
c = compareSnapshots(base, snap(base.resources[P][R].serials, R2), { allowed_migrations: [`${P}/${R}`] }); assert.ok(!c.blockers.includes("RESOURCE_REPLACED"));
const moved = { resources: { [P]: { [R]: { serials: { 1: base.resources[P][R].serials[1] } }, [R2]: { serials: { 2: base.resources[P][R].serials[2] } } } } };
const before = { resources: { [P]: { [R]: { serials: { 1: base.resources[P][R].serials[1], 2: base.resources[P][R].serials[2] } } } } };
c = compareSnapshots(before, moved); assert.ok(c.blockers.includes("RESOURCE_MOVED"));

// per-resource scoping: a problem in R must not block R2
const two = { resources: { [P]: { [R]: { serials: base.resources[P][R].serials }, [R2]: { serials: base.resources[P][R].serials } } } };
const twoShift = { resources: { [P]: { [R]: { serials: shifted.resources[P][R].serials }, [R2]: { serials: base.resources[P][R].serials } } } };
const cAll = compareSnapshots(two, twoShift);
assert.ok(comparisonForResource(cAll, R).blocked && !comparisonForResource(cAll, R2).blocked);

// cross-resource duplicate guard: never merges, only reports
const recs = [
  { key: "a", resource_uuid: R, name: "PARK 8", latitude: 38.0, longitude: 27.0 },
  { key: "b", resource_uuid: R2, name: "PARK 1", latitude: 38.0, longitude: 27.0 },
  { key: "c", resource_uuid: R2, name: "Uzak Parkı", latitude: 38.5, longitude: 27.5 },
  { key: "d", resource_uuid: R, name: "Uzak Parkı", latitude: 38.5, longitude: 27.5001 },
  { key: "e", resource_uuid: R, name: "PARK 2", latitude: 38.0, longitude: 27.0001 }
];
const pairs = crossResourceNearDuplicates(recs);
assert.ok(pairs.some(p => p.a === "a" && p.b === "b" && p.reasons.includes("very_close")));
assert.ok(pairs.some(p => p.a === "c" && p.b === "d" && p.reasons.includes("strong_name_nearby")));
assert.ok(!pairs.some(p => p.reasons.includes("strong_name_nearby") && (p.a_name === "PARK 8")), "placeholder names are never name evidence");
assert.ok(pairs.every(p => p.review_reason === "cross_resource_near_duplicate"));

// package-scope proof
assert.ok(!packageScopeProof({ upstream_geo_resource_uuids: [R, R2], loaded: { [R]: ["1", "2"] } }).proven);
assert.ok(!packageScopeProof({ upstream_geo_resource_uuids: [R, R2], loaded: { [R]: ["1", "2"], [R2]: ["2", "3"] } }).proven);
assert.ok(packageScopeProof({ upstream_geo_resource_uuids: [R, R2], loaded: { [R]: ["1", "2"], [R2]: ["3"] } }).proven);

// fail-closed validation
const good = { package_uuid: P, resource_uuid: R, records: [{ serial: "1" }, { serial: "2" }], companion_join: validateCompanionJoin(["1", "2"], ["1", "2"]), license_status: "SAFE_OPEN" };
assert.equal(validateScopedSerialResource(good).status, "READY_FOR_RECONCILIATION");
assert.equal(validateScopedSerialResource({ ...good, license_status: "BLOCKED_LICENSE" }).status, "BLOCKED_LICENSE");
assert.equal(validateScopedSerialResource({ ...good, records: [{ serial: "1" }, { serial: "1" }] }).status, "BLOCKED_IDENTITY");
assert.equal(validateScopedSerialResource({ ...good, records: [{ serial: "1" }, { serial: null }] }).status, "BLOCKED_IDENTITY");
assert.equal(validateScopedSerialResource({ ...good, package_uuid: null }).status, "BLOCKED_IDENTITY");
assert.equal(validateScopedSerialResource({ ...good, resource_uuid: null }).status, "BLOCKED_IDENTITY");
assert.equal(validateScopedSerialResource({ ...good, companion_join: null }).status, "BLOCKED_IDENTITY");
assert.equal(validateScopedSerialResource({ ...good, snapshot_comparison: { blocked: true, blockers: ["MASS_RENUMBERING"], counts: {} } }).status, "BLOCKED_IDENTITY");
assert.equal(validateScopedSerialResource({ ...good, resource_state: { replaced: true } }).status, "BLOCKED_IDENTITY");
// identity failure wins over license failure in the reported status; both are recorded
const both = validateScopedSerialResource({ ...good, records: [{ serial: "1" }, { serial: "1" }], license_status: "BLOCKED_LICENSE" });
assert.equal(both.status, "BLOCKED_IDENTITY"); assert.ok(both.failed.includes("I") && both.failed.includes("B"));

console.log("scoped-serial-identity: all assertions passed");

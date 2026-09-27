import assert from 'node:assert/strict';
import test from 'node:test';
import {
  favoriteView,
  lookupPark,
  parkMessages,
  parkRouteAction,
  parseResolution,
  type ParkLookupDeps,
  type ResolveRow,
} from '../src/core/park-lifecycle';
import type { Park } from '../src/core/types';

const park = (id: string, name = 'Test Parkı'): Park => ({
  id,
  name,
  city: 'Ordu',
  district: 'Altınordu',
  latitude: 40.98,
  longitude: 37.87,
  last_fed_at: null,
  last_grams: null,
  last_water_at: null,
  total_records: 0,
  food_status: 'unknown',
  water_status: 'unknown',
  observed_at: null,
});
const LIVE = '10000000-0000-4000-8000-000000000001',
  SURVIVOR = '10000000-0000-4000-8000-000000000002',
  ALIAS = '10000000-0000-4000-8000-000000000003',
  REVIEW = '10000000-0000-4000-8000-000000000004',
  NONPARK = '10000000-0000-4000-8000-000000000005',
  WITHDRAWN = '10000000-0000-4000-8000-000000000006',
  HIDDEN = '10000000-0000-4000-8000-000000000007',
  UNKNOWN = '10000000-0000-4000-8000-0000000000ff';

// A fake backend with the same contract as get_park + resolve_park_id, counting calls.
function backend() {
  const live = new Map([
    [LIVE, park(LIVE, 'Canlı Park')],
    [SURVIVOR, park(SURVIVOR, 'Birleşen Park')],
  ]);
  const rows: Record<string, ResolveRow> = {
    [LIVE]: { status: 'live', resolved_park_id: LIVE, tombstone_status: null },
    [SURVIVOR]: { status: 'live', resolved_park_id: SURVIVOR, tombstone_status: null },
    [ALIAS]: { status: 'alias', resolved_park_id: SURVIVOR, tombstone_status: null },
    [REVIEW]: { status: 'tombstone', resolved_park_id: null, tombstone_status: 'taxonomy_review' },
    [NONPARK]: { status: 'tombstone', resolved_park_id: null, tombstone_status: 'non_park' },
    [WITHDRAWN]: {
      status: 'tombstone',
      resolved_park_id: null,
      tombstone_status: 'source_withdrawn',
    },
    [HIDDEN]: { status: 'inactive', resolved_park_id: null, tombstone_status: null },
  };
  const calls = { loadPark: 0, resolve: 0 };
  const deps: ParkLookupDeps = {
    loadPark: async (id) => {
      calls.loadPark++;
      return live.get(id) ?? null;
    },
    resolve: async (id) => {
      calls.resolve++;
      return rows[id] ?? { status: 'not_found', resolved_park_id: null, tombstone_status: null };
    },
  };
  return { deps, calls, rows };
}

test('live id: served by the normal lookup, resolver never called (live flow unchanged)', async () => {
  const b = backend();
  const r = await lookupPark(LIVE, b.deps);
  assert.deepEqual(r.resolution, { kind: 'live', id: LIVE });
  assert.equal(r.park?.name, 'Canlı Park');
  assert.deepEqual(b.calls, { loadPark: 1, resolve: 0 });
  assert.deepEqual(parkRouteAction(r), { type: 'show', park: r.park });
});

test('alias -> survivor: one resolve call, one survivor lookup, redirect once', async () => {
  const b = backend();
  const r = await lookupPark(ALIAS, b.deps);
  assert.deepEqual(r.resolution, { kind: 'alias', id: SURVIVOR, from: ALIAS });
  assert.equal(r.park?.id, SURVIVOR);
  assert.deepEqual(b.calls, { loadPark: 2, resolve: 1 });
  assert.deepEqual(parkRouteAction(r), { type: 'redirect', id: SURVIVOR });
});

test('alias deep link: redirect lands on the survivor, which then shows (no second redirect)', async () => {
  const b = backend();
  // patika://park/<ALIAS> -> screen 1
  const first = parkRouteAction(await lookupPark(ALIAS, b.deps));
  assert.equal(first.type, 'redirect');
  // replaced by Park { id: SURVIVOR, redirectedFrom: ALIAS } -> screen 2
  const second = parkRouteAction(
    await lookupPark(first.type === 'redirect' ? first.id : '', b.deps),
    ALIAS,
  );
  assert.equal(second.type, 'show');
});

test('no redirect loop: a redirected screen never redirects again, and a broken survivor is not followed', async () => {
  const b = backend();
  const alias = await lookupPark(ALIAS, b.deps);
  assert.deepEqual(parkRouteAction(alias, 'some-earlier-id'), {
    type: 'unavailable',
    message: parkMessages.not_found,
  });
  // corrupt server data: alias to a survivor that is not live -> not found, no further resolve calls
  const c = backend();
  c.rows[ALIAS] = { status: 'alias', resolved_park_id: HIDDEN, tombstone_status: null };
  const r = await lookupPark(ALIAS, c.deps);
  assert.deepEqual(r.resolution, { kind: 'not_found' });
  assert.equal(c.calls.resolve, 1);
  // self-alias rows are never followed
  assert.deepEqual(
    parseResolution(ALIAS, { status: 'alias', resolved_park_id: ALIAS, tombstone_status: null }),
    { kind: 'not_found' },
  );
});

for (const [id, reason, title] of [
  [REVIEW, 'taxonomy_review', 'Bu konum şu anda doğrulanıyor.'],
  [NONPARK, 'non_park', 'Bu kayıt artık park olarak listelenmiyor.'],
  [WITHDRAWN, 'source_withdrawn', 'Bu park artık güncel park listesinde yer almıyor.'],
] as const) {
  test(`${reason} tombstone -> plain unavailable state`, async () => {
    const b = backend();
    const r = await lookupPark(id, b.deps);
    assert.deepEqual(r.resolution, { kind: 'retired', reason });
    assert.equal(r.park, null);
    const action = parkRouteAction(r);
    assert.equal(action.type, 'unavailable');
    assert.equal(action.type === 'unavailable' && action.message.title, title);
  });
}

test('unknown id and moderation-hidden id keep the existing "not found" behaviour', async () => {
  const b = backend();
  for (const id of [UNKNOWN, HIDDEN]) {
    const r = await lookupPark(id, b.deps);
    assert.deepEqual(r.resolution, { kind: 'not_found' });
    assert.deepEqual(parkRouteAction(r), { type: 'unavailable', message: parkMessages.not_found });
  }
  // backend without the lifecycle RPC (repository maps "function missing" to null)
  assert.deepEqual(parseResolution(UNKNOWN, null), { kind: 'not_found' });
  // a future tombstone status still gets a safe generic message
  assert.deepEqual(
    parseResolution(UNKNOWN, {
      status: 'tombstone',
      resolved_park_id: null,
      tombstone_status: 'x',
    }),
    { kind: 'retired', reason: 'other' },
  );
});

test('retired id cannot crash the detail flow: every outcome maps to a renderable action', async () => {
  const b = backend();
  for (const id of [LIVE, ALIAS, REVIEW, NONPARK, WITHDRAWN, HIDDEN, UNKNOWN]) {
    const action = parkRouteAction(await lookupPark(id, b.deps));
    assert.ok(['show', 'redirect', 'unavailable'].includes(action.type));
    if (action.type === 'unavailable') assert.ok(action.message.title && action.message.detail);
  }
});

test('network errors propagate (screens keep their existing offline handling)', async () => {
  const deps: ParkLookupDeps = {
    loadPark: async () => {
      throw new Error('offline');
    },
    resolve: async () => null,
  };
  await assert.rejects(lookupPark(ALIAS, deps), /offline/);
});

test('user-facing copy never exposes internal registry vocabulary', () => {
  for (const m of Object.values(parkMessages))
    for (const text of [m.title, m.detail])
      assert.doesNotMatch(
        text,
        /canonical|kanonik|tombstone|alias|taxonomy|source_withdrawn|non_park/i,
      );
});

test('favourites: merged ids show their survivor once, retired ids stay visible (never silently dropped)', async () => {
  const b = backend();
  const entries = [];
  for (const id of [LIVE, ALIAS, SURVIVOR, WITHDRAWN, UNKNOWN])
    entries.push({ id, lookup: await lookupPark(id, b.deps) });
  const view = favoriteView(entries);
  assert.deepEqual(
    view.parks.map((p) => p.id),
    [LIVE, SURVIVOR],
  );
  assert.deepEqual(
    view.unavailable.map((u) => [u.id, u.message.title]),
    [
      [WITHDRAWN, parkMessages.source_withdrawn.title],
      [UNKNOWN, parkMessages.not_found.title],
    ],
  );
});

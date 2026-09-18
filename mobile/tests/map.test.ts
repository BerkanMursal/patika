import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parkIndex,
  isMapEvent,
  mapRescueCases,
  mapVets,
  sameRegion,
  scriptJSON,
  type MapPark,
  type MapRescueRow,
  type MapVetRow,
} from '../src/components/map-model';

const parks: MapPark[] = [
  {
    id: 'a',
    name: 'Birinci park',
    latitude: 40.99,
    longitude: 29.04,
    color: '#7B8790',
    status: 'Kayıt bekliyor',
  },
  {
    id: 'b',
    name: 'İkinci park',
    latitude: 40.9904,
    longitude: 29.0404,
    color: '#2D7660',
    status: 'Yakın zamanda kayıt var',
  },
  {
    id: 'c',
    name: 'Uzak park',
    latitude: 41.15,
    longitude: 29.24,
    color: '#7B8790',
    status: 'Kayıt bekliyor',
  },
];
const box: [number, number, number, number] = [28, 40, 30, 42];

test('nearby parks cluster, keep every record and separate when zoomed in', () => {
  const index = parkIndex(parks);
  const features = index.getClusters(box, 12);
  const group = features.find((f) => 'cluster' in f.properties);
  assert.ok(group && 'point_count' in group.properties);
  assert.equal(group.properties.point_count, 2);
  assert.equal(features.length, 2);
  const expanded = index.getClusters(box, 18);
  assert.deepEqual(expanded.map((f) => f.properties.id).sort(), ['a', 'b', 'c']);
});

test('the selected park is kept outside clusters; bounds exclude distant parks', () => {
  const index = parkIndex(parks, 'a');
  const features = index.getClusters([29, 40.9, 29.1, 41], 12);
  assert.deepEqual(
    features.map((f) => f.properties.id),
    ['b'],
  );
});

test('cluster construction does not change caller order', () => {
  const reversed = [...parks].reverse();
  parkIndex(reversed);
  assert.deepEqual(
    reversed.map((p) => p.id),
    ['c', 'b', 'a'],
  );
});

test('the map bridge rejects invalid coordinates and accepts real viewport updates', () => {
  const region = { latitude: 41, longitude: 29, latitudeDelta: 0.1, longitudeDelta: 0.2 };
  assert.ok(isMapEvent({ type: 'move', region }));
  for (const bad of [NaN, Infinity, '41', undefined])
    assert.equal(isMapEvent({ type: 'move', region: { ...region, latitude: bad } }), false);
  assert.equal(isMapEvent({ type: 'move', region: { ...region, latitudeDelta: -1 } }), false);
  assert.equal(isMapEvent({ type: 'move', region: { ...region, longitude: 200 } }), false);
  assert.equal(isMapEvent({ type: 'select', id: 1 }), false);
  assert.ok(sameRegion(region, { ...region, longitude: 29.000001 }));
  assert.equal(sameRegion(region, { ...region, longitudeDelta: 0.4 }), false);
});

test('park names cannot break out of the native map script literal', () => {
  const value = { name: '</script><script>alert(1)</script>\u2028\u2029' };
  const encoded = scriptJSON(value);
  assert.equal(encoded.includes('<'), false);
  assert.deepEqual(JSON.parse(encoded), value);
});

test('mapRescueCases: reported/verifying are the alert icon, claimed through treating are the volunteer icon', () => {
  const rows: MapRescueRow[] = [
    'reported',
    'verifying',
    'claimed',
    'en_route',
    'at_vet',
    'treating',
  ].map((status, i) => ({
    id: `case-${i}`,
    latitude: 41,
    longitude: 29,
    status: status as MapRescueRow['status'],
  }));
  const mapped = mapRescueCases(rows);
  assert.deepEqual(
    mapped.map((m) => m.icon),
    ['\ud83d\udea8', '\ud83d\udea8', '\ud83d\ude4b', '\ud83d\ude4b', '\ud83d\ude4b', '\ud83d\ude4b'],
  );
  // Coordinates pass through untouched; id/lat/lng are all the marker needs
  // beyond the icon.
  assert.equal(mapped[0].id, 'case-0');
  assert.equal(mapped[0].latitude, 41);
  assert.equal(mapped[0].longitude, 29);
});

test('the map bridge accepts a valid selectRescue event and rejects a non-string id or unknown type', () => {
  assert.ok(isMapEvent({ type: 'selectRescue', id: 'aa111111-1111-4111-8111-111111111111' }));
  assert.equal(isMapEvent({ type: 'selectRescue', id: 1 }), false);
  assert.equal(isMapEvent({ type: 'selectRescue' }), false);
  assert.equal(isMapEvent({ type: 'selectAnimal', id: 'x' }), false);
});

test('rescue cases never reach parkIndex/Supercluster \u2014 park clustering is unaffected by their presence', () => {
  // Same fixture and expectations as "nearby parks cluster..." above: a
  // MapState carrying rescueCases alongside parks must still cluster parks
  // identically, because parkIndex only ever consumes state.parks.
  const state = {
    parks,
    rescueCases: mapRescueCases([
      { id: 'r1', latitude: 41, longitude: 29, status: 'reported' as const },
    ]),
  };
  const index = parkIndex(state.parks);
  const features = index.getClusters(box, 12);
  const group = features.find((f) => 'cluster' in f.properties);
  assert.ok(group && 'point_count' in group.properties);
  assert.equal(group.properties.point_count, 2);
  assert.equal(features.length, 2);
  // No rescue id/icon ever appears in a park cluster's properties.
  for (const feature of features) assert.equal('icon' in feature.properties, false);
});

test('mapVets: every row becomes a fixed 🏥 marker with coordinates passed through', () => {
  const rows: MapVetRow[] = [
    { id: 'vet-1', latitude: 40.98, longitude: 29.02 },
    { id: 'vet-2', latitude: 41.02, longitude: 29.09 },
  ];
  const mapped = mapVets(rows);
  assert.deepEqual(
    mapped.map((v) => v.icon),
    ['🏥', '🏥'],
  );
  assert.deepEqual(
    mapped.map((v) => [v.id, v.latitude, v.longitude]),
    [
      ['vet-1', 40.98, 29.02],
      ['vet-2', 41.02, 29.09],
    ],
  );
});

test('vets never reach parkIndex/Supercluster — park clustering is unaffected by their presence', () => {
  const state = {
    parks,
    vets: mapVets([{ id: 'v1', latitude: 41, longitude: 29 }]),
  };
  const index = parkIndex(state.parks);
  const features = index.getClusters(box, 12);
  const group = features.find((f) => 'cluster' in f.properties);
  assert.ok(group && 'point_count' in group.properties);
  assert.equal(group.properties.point_count, 2);
  assert.equal(features.length, 2);
  for (const feature of features) assert.equal('icon' in feature.properties, false);
});

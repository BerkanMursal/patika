import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parkIndex,
  isMapEvent,
  sameRegion,
  scriptJSON,
  type MapPark,
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

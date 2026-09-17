import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BoundaryCache,
  boundaryKeys,
  visibleBoundaries,
  type BoundaryCollection,
} from '../src/components/map-boundaries';
import type { MapPark } from '../src/components/map-model';

const { cleanGeometry, buildBoundaryTiles } = createRequire(import.meta.url)(
  '../scripts/park-boundaries.cjs',
);
const ring = [
  [29, 41],
  [29.01, 41],
  [29.01, 41.01],
  [29, 41.01],
  [29, 41],
];
const hole = [
  [29.002, 41.002],
  [29.004, 41.002],
  [29.004, 41.004],
  [29.002, 41.004],
  [29.002, 41.002],
];
const geometry = (coordinates: number[][]) => coordinates.map(([lon, lat]) => ({ lon, lat }));
const feature: BoundaryCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'a',
      properties: { id: 'a', osm_id: 'way/1' },
      geometry: { type: 'Polygon', coordinates: [ring] },
    },
  ],
};

test('boundary conversion retains relation holes and joins outer way segments', () => {
  const raw = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { leisure: 'park' },
        nodes: [1, 2, 3, 4, 1],
        geometry: geometry(ring),
      },
      {
        type: 'relation',
        id: 2,
        tags: { type: 'multipolygon', leisure: 'park' },
        members: [
          { type: 'way', ref: 20, role: 'outer', geometry: geometry(ring.slice(0, 3)) },
          { type: 'way', ref: 21, role: 'outer', geometry: geometry(ring.slice(2)) },
          { type: 'way', ref: 22, role: 'inner', geometry: geometry(hole) },
        ],
      },
      {
        type: 'way',
        id: 3,
        tags: { leisure: 'park' },
        nodes: [1, 2, 3],
        geometry: geometry(ring.slice(0, 3)),
      },
    ],
  };
  const catalog = [
    ['a', 'way/1', '', '', '', 41.005, 29.005],
    ['b', 'relation/2', '', '', '', 41.005, 29.005],
    ['c', 'way/3', '', '', '', 41.005, 29.005],
  ];
  const { tiles, stats } = buildBoundaryTiles(raw, catalog);
  const all = [...tiles.values()].flat();
  assert.deepEqual(all.map((f: any) => f.id).sort(), ['a', 'b']);
  assert.equal(all.find((f: any) => f.id === 'b').geometry.coordinates.length, 2);
  assert.equal(stats.withHoles, 1);
  assert.equal(stats.withoutBoundary, 1);
});

test('invalid or unclosed rings are rejected, without filling broken holes', () => {
  assert.equal(cleanGeometry({ type: 'Polygon', coordinates: [ring.slice(0, -1)] }), null);
  assert.equal(cleanGeometry({ type: 'Polygon', coordinates: [ring, hole.slice(0, -1)] }), null);
  assert.equal(
    cleanGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [29, 41],
          [NaN, 41],
          [29, 42],
          [29, 41],
        ],
      ],
    }),
    null,
  );
  assert.equal(
    cleanGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [29, 41],
          [30, 41],
          [31, 41],
          [29, 41],
        ],
      ],
    }),
    null,
  );
  const multi = cleanGeometry({ type: 'MultiPolygon', coordinates: [[ring, hole], [ring]] });
  assert.equal(multi.coordinates.length, 2);
  assert.equal(multi.coordinates[0].length, 2);
});

const tiles = Object.fromEntries(
  ['116-164', '120-160', '121-160', '122-160'].map((key) => [
    key,
    { file: `${key}.json`, count: 1, bytes: 100 },
  ]),
);
const parks = [
  { id: 'a', longitude: 29.005, latitude: 41.005 },
  { id: 'b', longitude: 30.1, latitude: 40.1 },
] as MapPark[];
test('boundary loading stays in the viewport, includes selection, and obeys park filters', () => {
  assert.deepEqual(boundaryKeys(parks, [29, 41, 29.1, 41.1], tiles), ['116-164']);
  assert.deepEqual(boundaryKeys(parks, [29, 41, 29.1, 41.1], tiles, 'b'), ['116-164', '120-160']);
  assert.equal(visibleBoundaries([feature], [], 'a').features.length, 0);
  assert.equal(visibleBoundaries([feature], parks, 'a').features[0].properties.selected, true);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
test('default boundary transport preserves the browser fetch receiver', async (t) => {
  t.mock.method(globalThis, 'fetch', async function (this: unknown) {
    // Native browser fetch rejects a class instance as its receiver.
    assert.ok(this === undefined || this === globalThis);
    return new Response(JSON.stringify(feature));
  });
  const cache = new BoundaryCache(tiles, 'https://example.com/data/', () => {});
  cache.update(['116-164']);
  await flush();
  assert.equal(cache.snapshot.failed, false);
  assert.equal(cache.snapshot.collections.length, 1);
  cache.destroy();
});
test('boundary cache retries failures and reuses completed downloads', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return new Response(calls === 1 ? 'unavailable' : JSON.stringify(feature), {
      status: calls === 1 ? 503 : 200,
    });
  };
  const cache = new BoundaryCache(
    tiles,
    'https://example.com/data/',
    () => {},
    request as typeof fetch,
  );
  cache.update(['116-164']);
  await flush();
  assert.equal(cache.snapshot.failed, true);
  cache.retry();
  await flush();
  assert.equal(cache.snapshot.failed, false);
  assert.equal(cache.snapshot.collections.length, 1);
  cache.update([]);
  cache.update(['116-164']);
  await flush();
  assert.equal(calls, 2);
  cache.destroy();
});

test('boundary cache bounds concurrency and aborts obsolete requests and teardown', async () => {
  const signals: AbortSignal[] = [];
  const request = (_url: unknown, options: RequestInit) => {
    signals.push(options.signal!);
    return new Promise<Response>((_resolve, reject) =>
      options.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  };
  let notifications = 0;
  const cache = new BoundaryCache(
    tiles,
    'https://example.com/data/',
    () => notifications++,
    request as typeof fetch,
  );
  cache.update(Object.keys(tiles));
  assert.equal(signals.length, 3);
  cache.update(['122-160']);
  assert.equal(
    signals.slice(0, 3).every((s) => s.aborted),
    true,
  );
  assert.equal(signals.length, 4);
  cache.destroy();
  await flush();
  assert.equal(
    signals.every((s) => s.aborted),
    true,
  );
  assert.equal(notifications, 0);
});

test('published boundary files have valid polygons, unique catalog IDs and matching content hashes', () => {
  const base = new URL('../public/data/park-boundaries/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
  const catalog = JSON.parse(
    readFileSync(new URL('../src/core/parks.json', import.meta.url), 'utf8'),
  );
  const byId = new Map(catalog.map((row: any[]) => [row[0], row]));
  const ids = new Set<string>();
  for (const tile of Object.values(manifest.tiles) as {
    file: string;
    count: number;
    bytes: number;
  }[]) {
    const raw = readFileSync(new URL(tile.file, base));
    assert.equal(raw.length, tile.bytes);
    assert.ok(
      tile.file.endsWith(`-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}.json`),
    );
    const data = JSON.parse(raw.toString());
    assert.equal(data.features.length, tile.count);
    for (const f of data.features) {
      assert.ok(byId.has(f.id));
      assert.equal(ids.has(f.id), false);
      ids.add(f.id);
      assert.ok(cleanGeometry(f.geometry));
    }
  }
  assert.equal(ids.size, manifest.boundaries);
  assert.equal(manifest.boundaries + manifest.withoutBoundary, catalog.length);
  assert.deepEqual(
    manifest,
    JSON.parse(
      readFileSync(new URL('../src/core/boundary-manifest.json', import.meta.url), 'utf8'),
    ),
  );
});

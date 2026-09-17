import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  parkCode,
  parkDisplayName,
  presentPark,
  restoreParkActivity,
  validateNameSuggestion,
} from '../src/core/park-names';
import type { Park } from '../src/core/types';
// The import pipeline is plain ESM so it is also runnable without Expo.
import {
  containing,
  geometryIndex,
  uniquePointMatch,
  parseCSV,
} from '../../scripts/park-enrichment.mjs';

const park: Park = {
  id: '75190a14-8af2-5b9d-8466-c85295230bfe',
  osm_id: 'node/1426231190',
  name: 'İsimsiz park',
  city: 'Muğla',
  district: 'Fethiye',
  latitude: 36.69,
  longitude: 28.04,
  last_fed_at: null,
  last_grams: null,
  last_water_at: null,
  total_records: 0,
  food_status: 'unknown',
  water_status: 'unknown',
  observed_at: null,
};
test('missing park names have stable identities across map and feeding history', () => {
  const displayed = presentPark(park);
  assert.equal(displayed.name_status, 'missing');
  assert.equal(presentPark(displayed).name, displayed.name);
  assert.equal(parkDisplayName(park.id, park.name), displayed.name);
  assert.notEqual(
    displayed.name,
    presentPark({ ...park, id: '64190a14-8af2-5b9d-8466-c85295230bfe' }).name,
  );
  assert.equal(presentPark({ ...park, name: 'Pınar Parkı' }).name, 'Pınar Parkı');
  assert.equal(
    presentPark({
      ...park,
      name: 'Pınar Parkı',
      name_status: 'community',
      name_source: 'Topluluk incelemesi',
    }).name_source_url,
    '',
  );
});
test('all catalog park codes are unique and enrichment never drops IDs', async () => {
  const rows = JSON.parse(
    await readFile(new URL('../src/core/parks.json', import.meta.url), 'utf8'),
  );
  const source = JSON.parse(
    await readFile(new URL('../../data/parks-turkey.json', import.meta.url), 'utf8'),
  );
  assert.equal(new Set(rows.map((r: any[]) => parkCode({ id: r[0] }))).size, rows.length);
  assert.deepEqual(
    rows.map((r: any[]) => r[1]).sort(),
    source.elements.map((e: any) => `${e.type}/${e.id}`).sort(),
  );
  const manifest = JSON.parse(
    await readFile(new URL('../../data/park-enrichment/sources.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(new URL('../src/core/enrichment-sources.json', import.meta.url), 'utf8'),
    ),
    manifest,
  );
  for (const snapshot of manifest.sources) {
    const bytes = await readFile(
      new URL('../../data/park-enrichment/' + snapshot.file, import.meta.url),
    );
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      snapshot.sha256,
      snapshot.file + ' snapshot checksum',
    );
  }
});
test('old saved demo activity cannot restore outdated names or coordinates', () => {
  const canonical = {
    ...park,
    name: 'Karanfil Sokak Parkı',
    name_status: 'municipal' as const,
    address_label: 'Yeni adres',
  };
  const saved = { ...park, latitude: 0, name: 'Eski park adı', last_grams: 250, total_records: 1 };
  const restored = restoreParkActivity(canonical, saved);
  assert.equal(restored.name, canonical.name);
  assert.equal(restored.name_status, 'municipal');
  assert.equal(restored.latitude, canonical.latitude);
  assert.equal(restored.address_label, 'Yeni adres');
  assert.equal(restored.last_grams, 250);
});
test('proposals require a real name and a verifiable explanation', () => {
  assert.equal(
    validateNameSuggestion('Şehit Ömer Parkı', 'Giriş tabelasında bu ad yazıyor.'),
    null,
  );
  for (const value of [
    'ab',
    '12345',
    'Park',
    'İsimsiz park',
    '<script>Park</script>',
    'https://example.com',
    'Park\nAdı',
  ])
    assert.ok(validateNameSuggestion(value, 'Giriş tabelası kontrol edilebilir.'));
  assert.ok(validateNameSuggestion('Yeni Park', 'kısa'));
  assert.ok(validateNameSuggestion('Yeni Park', 'x'.repeat(601)));
});
test('polygon matches exclude holes, outside points and retain ambiguity for review', () => {
  const shape = {
    type: 'Feature',
    properties: { adi: 'Park' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    },
  };
  const index = geometryIndex([shape]);
  assert.equal(containing(index, 2, 2).length, 1);
  assert.equal(containing(index, 5, 5).length, 0);
  assert.equal(containing(index, 12, 2).length, 0);
  assert.equal(containing(geometryIndex([shape, shape]), 2, 2).length, 2);
});
test('nearby parks are never named by nearest point alone', () => {
  const p = { latitude: 41, longitude: 29 },
    candidate = { ...p, name: 'Kaynak Parkı' };
  assert.equal(uniquePointMatch(p, [p], [candidate]), candidate);
  assert.equal(uniquePointMatch(p, [p, p], [candidate]), null);
  assert.equal(uniquePointMatch(p, [p], [candidate, candidate]), null);
  assert.equal(uniquePointMatch(p, [p], [{ latitude: 41.001, longitude: 29 }]), null);
});
test('municipal CSV parser preserves Turkish text, quoted commas and line breaks', () => {
  assert.deepEqual(parseCSV('\uFEFFAD,ADRES\r\n"Özgürlük, Parkı","Mahalle\nSokak"\r\n'), [
    { AD: 'Özgürlük, Parkı', ADRES: 'Mahalle\nSokak' },
  ]);
  assert.throws(() => parseCSV('AD\n"yarım'), /Unclosed/);
});

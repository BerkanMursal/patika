import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeQueuedFeeding,
  failQueuedFeeding,
  submitQueuedFeeding,
  type QueueDeps,
} from '../src/core/offline-queue';
import { lookupPark, type ResolveRow } from '../src/core/park-lifecycle';
import type { FeedingDraft, Park, Pending } from '../src/core/types';

const A = '30000000-0000-4000-8000-00000000000a', // merged into B
  B = '30000000-0000-4000-8000-00000000000b', // surviving park
  L = '30000000-0000-4000-8000-00000000000c', // live, untouched
  C = '30000000-0000-4000-8000-0000000000cc', // custom feeding point (not a park id)
  REVIEW = '30000000-0000-4000-8000-000000000001',
  NONPARK = '30000000-0000-4000-8000-000000000002',
  WITHDRAWN = '30000000-0000-4000-8000-000000000003',
  UNKNOWN = '30000000-0000-4000-8000-0000000000ff';
const park = (id: string): Park => ({
  id,
  name: `Park ${id.slice(-2)}`,
  city: 'Ordu',
  district: '',
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
const item = (
  park_id: string,
  point_id: string,
  id = '40000000-0000-4000-8000-000000000001',
): Pending => ({
  id,
  user_id: 'user-1',
  park_id,
  point_id,
  park_name: 'Eski ad',
  food_type: 'dry',
  food_grams: 200,
  water_ml: 0,
  note: '',
  occurred_at: '2026-09-27T08:00:00.000Z',
  photo_uri: 'file:///queued/photo.jpg',
  reported_latitude: 40.98,
  reported_longitude: 37.87,
  status: 'pending',
  attempts: 0,
});

// Fake get_park + resolve_park_id backend and a recording submit_feeding.
function deps({ submitError, lookupError }: { submitError?: Error; lookupError?: Error } = {}) {
  const live = new Map([B, L].map((id) => [id, park(id)]));
  const rows: Record<string, ResolveRow> = {
    [A]: { status: 'alias', resolved_park_id: B, tombstone_status: null },
    [REVIEW]: { status: 'tombstone', resolved_park_id: null, tombstone_status: 'taxonomy_review' },
    [NONPARK]: { status: 'tombstone', resolved_park_id: null, tombstone_status: 'non_park' },
    [WITHDRAWN]: {
      status: 'tombstone',
      resolved_park_id: null,
      tombstone_status: 'source_withdrawn',
    },
  };
  const submitted: FeedingDraft[] = [];
  const d: QueueDeps = {
    resolvePark: (id) =>
      lookupPark(id, {
        loadPark: async (x) => {
          if (lookupError) throw lookupError;
          return live.get(x) ?? null;
        },
        resolve: async (x) =>
          rows[x] ?? { status: 'not_found', resolved_park_id: null, tombstone_status: null },
      }),
    submit: async (draft) => {
      submitted.push(draft);
      if (submitError) throw submitError;
      return draft.id;
    },
  };
  return { d, submitted };
}
// One iteration of AppProvider.sync for a configured backend: submit, then the queue's
// success (remove) or failure (keep, mark error) transition.
async function syncStep(queue: Pending[], queued: Pending, d: QueueDeps) {
  try {
    await submitQueuedFeeding(queued, d);
    return completeQueuedFeeding(queue, queued.id);
  } catch (e) {
    return failQueuedFeeding(queue, queued.id, e);
  }
}

test('1. live park: submitted unchanged (same payload object), queue item completed', async () => {
  const { d, submitted } = deps();
  const q = item(L, L);
  const after = await syncStep([q], q, d);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], q); // identical object: normal submission is untouched
  assert.deepEqual(after, []);
});

test('2. merged park + general point: park A / point A -> park B / point B', async () => {
  const { d, submitted } = deps();
  const q = item(A, A);
  await syncStep([q], q, d);
  assert.equal(submitted[0].park_id, B);
  assert.equal(submitted[0].point_id, B);
  assert.deepEqual({ ...submitted[0], park_id: A, point_id: A }, q); // nothing else changed
});

test('3. merged park + custom point C: park -> B, point C kept', async () => {
  const { d, submitted } = deps();
  const q = item(A, C);
  await syncStep([q], q, d);
  assert.equal(submitted[0].park_id, B);
  assert.equal(submitted[0].point_id, C);
});

for (const [label, id, text] of [
  ['4. taxonomy_review', REVIEW, 'Bu konum şu anda doğrulanıyor.'],
  ['5. non_park', NONPARK, 'Bu kayıt artık park olarak listelenmiyor.'],
  ['6. source_withdrawn', WITHDRAWN, 'Bu park artık güncel park listesinde yer almıyor.'],
  ['7. unknown id', UNKNOWN, 'Park bulunamadı'],
] as const) {
  test(`${label}: not submitted, item preserved with the normal failed state`, async () => {
    const { d, submitted } = deps();
    const q = item(id, id);
    const other = item(L, L, '40000000-0000-4000-8000-000000000002');
    const after = await syncStep([q, other], q, d);
    assert.equal(submitted.length, 0);
    assert.equal(after.length, 2);
    const kept = after.find((x) => x.id === q.id)!;
    assert.deepEqual(
      { ...kept, status: 'pending', attempts: 0, error: undefined },
      { ...q, error: undefined },
    );
    assert.equal(kept.status, 'error');
    assert.equal(kept.attempts, 1);
    assert.ok(kept.error?.startsWith(text), String(kept.error));
    assert.match(kept.error!, /iptal edebilir veya daha sonra tekrar deneyebilirsin/);
    assert.equal(
      after.find((x) => x.id === other.id),
      other,
    ); // other items untouched
  });
}

test('8. lookup/network failure: existing retry semantics (kept, error, attempts+1, nothing submitted)', async () => {
  const { d, submitted } = deps({ lookupError: new Error('Network request failed') });
  const q = { ...item(A, A), status: 'error' as const, attempts: 2, error: 'önceki hata' };
  const after = await syncStep([q], q, d);
  assert.equal(submitted.length, 0);
  assert.deepEqual(after, [{ ...q, attempts: 3, error: 'Network request failed' }]);
  // a later retry with connectivity succeeds through the normal path
  const ok = deps();
  assert.deepEqual(await syncStep(after, after[0], ok.d), []);
  assert.equal(ok.submitted[0].park_id, B);
});

test('9. successful merged-park submission completes the queue item normally', async () => {
  const { d } = deps();
  const q = item(A, A),
    other = item(L, L, '40000000-0000-4000-8000-000000000002');
  assert.deepEqual(await syncStep([q, other], q, d), [other]);
});

test('10. failed merged-park submission does not rewrite or delete the queued record', async () => {
  const { d, submitted } = deps({ submitError: new Error('Geçerli besleme noktası gerekli.') });
  const q = item(A, C);
  const snapshot = structuredClone(q);
  const after = await syncStep([q], q, d);
  assert.equal(submitted[0].park_id, B); // the remapped payload was attempted...
  assert.deepEqual(q, snapshot); // ...but the stored item was never mutated
  assert.deepEqual(after, [
    { ...snapshot, status: 'error', attempts: 1, error: 'Geçerli besleme noktası gerekli.' },
  ]);
  assert.equal(after[0].park_id, A); // original park / point stay recorded
  assert.equal(after[0].point_id, C);
});

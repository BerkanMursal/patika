import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canClaimRescueCase,
  distanceKm,
  isRescueCaseAuthError,
  mergeFeeding,
  normalizeSearch,
  parkStatus,
  rescueCaseAccessGate,
  timeAgo,
  validateFeeding,
} from '../src/core/domain';
import { demoData } from '../src/core/demo';
import type { FeedingDraft } from '../src/core/types';
const now = Date.parse('2026-09-13T12:00:00Z');
test('Turkish park search accepts ASCII spellings and capital I', () => {
  assert.equal(normalizeSearch('İSTANBUL'), normalizeSearch('Istanbul'));
  assert.equal(normalizeSearch('Yoğurtçu Parkı'), normalizeSearch('yogurtcu parki'));
});
const draft: FeedingDraft = {
  id: 'a',
  user_id: 'u',
  point_id: 'p',
  park_id: 'park',
  park_name: 'Park',
  food_type: 'dry',
  food_grams: 250,
  water_ml: 0,
  note: '',
  occurred_at: new Date(now).toISOString(),
  photo_uri: 'photo.jpg',
};
test('accepts food-only and water-only records', () => {
  assert.equal(validateFeeding(draft, now), null);
  assert.equal(validateFeeding({ ...draft, food_grams: 0, water_ml: 500 }, now), null);
});
test('rejects zero, fractions, negative, NaN and missing photos', () => {
  for (const grams of [-1, 0.3, NaN, 100001])
    assert.ok(validateFeeding({ ...draft, food_grams: grams }, now));
  assert.ok(validateFeeding({ ...draft, food_grams: 0 }, now));
  assert.ok(validateFeeding({ ...draft, photo_uri: '' }, now));
});
test('rejects future or expired events', () => {
  assert.ok(validateFeeding({ ...draft, occurred_at: '2028-01-01' }, now));
  assert.ok(validateFeeding({ ...draft, occurred_at: '2020-01-01' }, now));
});
test('an old record never claims animals have been hungry', () => {
  const p = demoData().parks[0];
  assert.equal(
    parkStatus({ ...p, last_fed_at: null, observed_at: null }, now).label,
    'Kayıt bekliyor',
  );
  assert.equal(
    parkStatus({ ...p, last_fed_at: '2026-08-01', observed_at: null }, now).label,
    'Kayıt güncel değil',
  );
});
test('expired empty-bowl observations are not presented as current', () => {
  const p = demoData().parks[0];
  assert.notEqual(
    parkStatus({ ...p, food_status: 'empty', observed_at: '2026-08-01' }, now).key,
    'check',
  );
});
test('late arrival does not overwrite a newer feeding', () => {
  const p = { ...demoData().parks[0], last_fed_at: '2026-09-13T11:00:00Z', last_grams: 250 };
  const [changed] = mergeFeeding([p], {
    park_id: p.id,
    food_grams: 500,
    water_ml: 0,
    occurred_at: '2026-09-01T10:00:00Z',
  });
  assert.equal(changed.last_grams, 250);
  assert.equal(changed.last_fed_at, p.last_fed_at);
});
test('water-only does not replace last food record', () => {
  const p = demoData().parks[0];
  const [changed] = mergeFeeding([p], {
    park_id: p.id,
    food_grams: 0,
    water_ml: 500,
    occurred_at: new Date(now).toISOString(),
  });
  assert.equal(changed.last_fed_at, p.last_fed_at);
});
test('canClaimRescueCase matches claim_rescue_case: fresh claim, orphan reclaim of an in-progress case, but never a live-volunteer or resolved case', () => {
  // Fresh claim: unassigned reported/verifying.
  assert.equal(canClaimRescueCase({ status: 'reported', assigned_volunteer_id: null }), true);
  assert.equal(canClaimRescueCase({ status: 'verifying', assigned_volunteer_id: null }), true);
  // Orphan reclaim: assigned_volunteer_id went null (volunteer deleted their
  // account) while the case was already in progress — self-service
  // re-adoption must be offered at each of these statuses.
  for (const status of ['claimed', 'en_route', 'at_vet', 'treating'] as const)
    assert.equal(canClaimRescueCase({ status, assigned_volunteer_id: null }), true);
  // A live (non-deleted) volunteer blocks claiming regardless of status.
  for (const status of ['reported', 'claimed', 'en_route', 'at_vet', 'treating'] as const)
    assert.equal(canClaimRescueCase({ status, assigned_volunteer_id: 'some-uid' }), false);
  // 'resolved' is terminal: never claimable, assigned or not.
  assert.equal(canClaimRescueCase({ status: 'resolved', assigned_volunteer_id: null }), false);
  assert.equal(canClaimRescueCase({ status: 'resolved', assigned_volunteer_id: 'some-uid' }), false);
});
test('rescueCaseAccessGate: demo beats missing viewer, a real viewer proceeds', () => {
  assert.equal(rescueCaseAccessGate(true, 'u'), 'unavailable');
  assert.equal(rescueCaseAccessGate(false, null), 'unauthenticated');
  assert.equal(rescueCaseAccessGate(false, undefined), 'unauthenticated');
  assert.equal(rescueCaseAccessGate(false, 'u'), 'proceed');
});
test('isRescueCaseAuthError: only a structured 42501 code counts, never message text or network errors', () => {
  assert.equal(isRescueCaseAuthError({ code: '42501' }), true);
  assert.equal(isRescueCaseAuthError({ code: '23514' }), false);
  assert.equal(isRescueCaseAuthError(new Error('network')), false);
  assert.equal(isRescueCaseAuthError(null), false);
  assert.equal(isRescueCaseAuthError(undefined), false);
});
test('distance and date formatting are bounded', () => {
  assert.equal(distanceKm(41, 29, 41, 29), 0);
  assert.ok(distanceKm(41, 29, 40, 29) > 100);
  assert.equal(timeAgo(null, now), 'Henüz kayıt yok');
  assert.equal(timeAgo(new Date(now + 60000).toISOString(), now), 'Az önce');
});

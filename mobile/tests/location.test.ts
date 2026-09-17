import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBrowserLocation } from '../src/services/location.web';
import {
  LocationFailure,
  locationDeadline,
  locationFailureMessage,
} from '../src/services/location-common';

function position(latitude = 38.4237, longitude = 27.1428): GeolocationPosition {
  return { coords: { latitude, longitude, accuracy: 30 } } as GeolocationPosition;
}

test('browser requests one fresh-enough position without a separate permission lookup', async () => {
  let calls = 0;
  const result = await getBrowserLocation({
    getCurrentPosition(success, _error, options) {
      calls++;
      assert.deepEqual(options, { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
      success(position());
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { latitude: 38.4237, longitude: 27.1428, accuracy: 30 });
});

for (const [code, kind] of [
  [1, 'denied'],
  [2, 'unavailable'],
  [3, 'timeout'],
] as const) {
  test(`browser error ${code} stays ${kind}, even when it is not an Error instance`, async () => {
    await assert.rejects(
      getBrowserLocation({
        getCurrentPosition(_success, error) {
          error!({ code, message: 'Browser provider response' } as GeolocationPositionError);
        },
      }),
      (error: unknown) => error instanceof LocationFailure && error.kind === kind,
    );
  });
}

test('unsupported and insecure browsers fail without requesting permission', async () => {
  let called = false;
  await assert.rejects(getBrowserLocation(undefined), { kind: 'unsupported' });
  await assert.rejects(
    getBrowserLocation(
      {
        getCurrentPosition() {
          called = true;
        },
      },
      false,
    ),
    { kind: 'insecure' },
  );
  assert.equal(called, false);
});

test('unresponsive browser is released after 15 seconds and late positions are ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let lateSuccess: PositionCallback | undefined;
  let resolved = false;
  const pending = getBrowserLocation({
    getCurrentPosition(success) {
      lateSuccess = success;
    },
  });
  const settled = pending.then(
    () => {
      resolved = true;
    },
    (error) => error,
  );
  await Promise.resolve();
  t.mock.timers.tick(15000);
  assert.equal((await settled).kind, 'timeout');
  lateSuccess!(position());
  await Promise.resolve();
  assert.equal(resolved, false);
  // A retry is independent from the timed-out browser request.
  assert.equal(
    (
      await getBrowserLocation({
        getCurrentPosition(success) {
          success(position());
        },
      })
    ).latitude,
    38.4237,
  );
});

test('invalid provider coordinates cannot move the map', async () => {
  for (const latitude of [NaN, Infinity, 91]) {
    await assert.rejects(
      getBrowserLocation({
        getCurrentPosition(success) {
          success(position(latitude));
        },
      }),
      { kind: 'unavailable' },
    );
  }
  await assert.rejects(
    getBrowserLocation({
      getCurrentPosition(success) {
        success(position(0, -181));
      },
    }),
    { kind: 'unavailable' },
  );
});

test('deadline preserves provider failures and catches synchronous throws', async () => {
  await assert.rejects(
    locationDeadline(() => Promise.reject(new LocationFailure('disabled'))),
    { kind: 'disabled' },
  );
  await assert.rejects(
    locationDeadline(() => {
      throw new LocationFailure('denied');
    }),
    { kind: 'denied' },
  );
});

test('unavailable and timeout messages do not misreport a permission refusal', () => {
  for (const web of [true, false]) {
    for (const kind of ['unavailable', 'timeout'] as const) {
      assert.doesNotMatch(locationFailureMessage(new LocationFailure(kind), web), /Konum izni/);
    }
    assert.match(locationFailureMessage(new LocationFailure('denied'), web), /Konum izni/);
  }
});

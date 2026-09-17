import {
  locationCoordinates,
  locationDeadline,
  LocationFailure,
  type DeviceLocation,
} from './location-common';

type BrowserGeolocation = Pick<Geolocation, 'getCurrentPosition'>;

// One position request also handles the browser's permission prompt. Expo's web
// permission helper makes a separate, unbounded request and loses error codes.
export function getBrowserLocation(
  geolocation: BrowserGeolocation | undefined,
  secure = true,
): Promise<DeviceLocation> {
  if (!secure) return Promise.reject(new LocationFailure('insecure'));
  if (!geolocation) return Promise.reject(new LocationFailure('unsupported'));
  return locationDeadline(
    () =>
      new Promise((resolve, reject) => {
        geolocation.getCurrentPosition(
          (position) => {
            try {
              resolve(locationCoordinates(position.coords));
            } catch (error) {
              reject(error);
            }
          },
          (error) =>
            reject(
              new LocationFailure(
                error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable',
              ),
            ),
          { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
        );
      }),
  );
}

export function getDeviceLocation() {
  return getBrowserLocation(
    globalThis.navigator?.geolocation,
    globalThis.isSecureContext !== false,
  );
}

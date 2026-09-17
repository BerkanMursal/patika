import * as Location from 'expo-location';
import { locationCoordinates, locationDeadline, LocationFailure } from './location-common';

export function getDeviceLocation() {
  return locationDeadline(async () => {
    if (!(await Location.hasServicesEnabledAsync())) throw new LocationFailure('disabled');
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) throw new LocationFailure('denied');
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return locationCoordinates(position.coords);
  }, 20000);
}

import Supercluster from 'supercluster';
import { parkStatus } from '../core/domain';
import type { Park, Region } from '../core/types';

export type MapPark = Pick<Park, 'id' | 'name' | 'latitude' | 'longitude'> & {
  color: string;
  status: string;
};
export type MapState = {
  parks: MapPark[];
  region: Region;
  selected?: string;
  userLocation?: { latitude: number; longitude: number };
};
export type MapEvent =
  { type: 'ready' } | { type: 'select'; id: string } | { type: 'move'; region: Region };

export function mapParks(parks: Park[]): MapPark[] {
  return parks.map((p) => {
    const status = parkStatus(p);
    return {
      id: p.id,
      name: p.name,
      latitude: p.latitude,
      longitude: p.longitude,
      color: status.color,
      status: status.label,
    };
  });
}

export function parkIndex(parks: MapPark[], selected?: string) {
  return new Supercluster<MapPark>({ radius: 62, maxZoom: 17 }).load(
    parks
      .filter((p) => p.id !== selected)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        type: 'Feature' as const,
        properties: p,
        geometry: { type: 'Point' as const, coordinates: [p.longitude, p.latitude] },
      })),
  );
}

export function sameRegion(a: Region, b: Region) {
  return (Object.keys(a) as (keyof Region)[]).every((key) => Math.abs(a[key] - b[key]) < 0.00001);
}

export function isMapEvent(value: unknown): value is MapEvent {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (data.type === 'ready') return true;
  if (data.type === 'select') return typeof data.id === 'string';
  if (data.type !== 'move' || !data.region || typeof data.region !== 'object') return false;
  const r = data.region as Region;
  return (
    [r.latitude, r.longitude, r.latitudeDelta, r.longitudeDelta].every(Number.isFinite) &&
    Math.abs(r.latitude) <= 85 &&
    Math.abs(r.longitude) <= 180 &&
    r.latitudeDelta > 0 &&
    r.latitudeDelta <= 170 &&
    r.longitudeDelta > 0 &&
    r.longitudeDelta <= 360
  );
}

// All data inserted in the WebView document stays in a JSON literal.
export function scriptJSON(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

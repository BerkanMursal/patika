import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import type { MapPark } from './map-model';

export type BoundaryCollection = FeatureCollection<
  Polygon | MultiPolygon,
  { id: string; osm_id: string }
>;
export type BoundaryTiles = Record<string, { file: string; count: number; bytes: number }>;
export const emptyBoundaries = (): BoundaryCollection => ({
  type: 'FeatureCollection',
  features: [],
});

export function boundaryKeys(
  parks: MapPark[],
  bounds: [number, number, number, number],
  tiles: BoundaryTiles,
  selected?: string,
) {
  return [
    ...new Set(
      parks
        .filter(
          (p) =>
            p.id === selected ||
            (p.longitude >= bounds[0] &&
              p.longitude <= bounds[2] &&
              p.latitude >= bounds[1] &&
              p.latitude <= bounds[3]),
        )
        .map((p) => `${Math.floor(p.longitude * 4)}-${Math.floor(p.latitude * 4)}`),
    ),
  ]
    .filter((key) => Object.hasOwn(tiles, key))
    .sort();
}

export function visibleBoundaries(
  collections: BoundaryCollection[],
  parks: MapPark[],
  selected?: string,
) {
  const ids = new Set(parks.map((p) => p.id));
  return {
    type: 'FeatureCollection' as const,
    features: collections
      .flatMap((c) => c.features)
      .filter((f) => ids.has(f.properties.id))
      .map((f) => ({
        ...f,
        properties: { ...f.properties, selected: f.properties.id === selected },
      })),
  };
}

// A bounded cache shared by the web iframe and native WebView runtime.
export class BoundaryCache {
  private active = new Set<string>();
  private cache = new Map<string, BoundaryCollection>();
  private requests = new Map<string, AbortController>();
  private errors = new Set<string>();
  private destroyed = false;
  constructor(
    private tiles: BoundaryTiles,
    private base: string,
    private changed: () => void,
    private request: typeof fetch = (input, init) => fetch(input, init),
    private limit = 48,
  ) {}

  update(keys: string[]) {
    this.active = new Set(keys.filter((key) => Object.hasOwn(this.tiles, key)));
    for (const [key, controller] of this.requests)
      if (!this.active.has(key)) {
        controller.abort();
        this.requests.delete(key);
      }
    for (const key of this.errors) if (!this.active.has(key)) this.errors.delete(key);
    this.trim();
    this.pump();
  }
  retry() {
    this.errors.clear();
    this.pump();
    this.changed();
  }
  get snapshot() {
    const keys = [...this.active];
    return {
      collections: keys.flatMap((key) => (this.cache.has(key) ? [this.cache.get(key)!] : [])),
      loading: keys.some((key) => !this.cache.has(key) && !this.errors.has(key)),
      failed: keys.some((key) => this.errors.has(key)),
    };
  }
  private trim() {
    for (const key of this.cache.keys())
      if (this.cache.size > this.limit && !this.active.has(key)) this.cache.delete(key);
  }
  private pump() {
    if (this.destroyed) return;
    for (const key of this.active) {
      if (this.requests.size >= 3) break;
      if (this.cache.has(key) || this.requests.has(key) || this.errors.has(key)) continue;
      const controller = new AbortController();
      this.requests.set(key, controller);
      const timer = setTimeout(() => controller.abort(), 15000);
      void this.request(new URL(this.tiles[key].file, this.base).href, {
        signal: controller.signal,
        credentials: 'omit',
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('Boundary download failed');
          const data = (await response.json()) as BoundaryCollection;
          if (
            data.type !== 'FeatureCollection' ||
            !Array.isArray(data.features) ||
            data.features.some(
              (f) =>
                typeof f.properties?.id !== 'string' ||
                !['Polygon', 'MultiPolygon'].includes(f.geometry?.type),
            )
          )
            throw new Error('Invalid boundary data');
          if (!this.destroyed && this.requests.get(key) === controller) this.cache.set(key, data);
        })
        .catch((error: unknown) => {
          if (!this.destroyed && this.requests.get(key) === controller) {
            this.errors.add(key);
            console.warn(
              'Park boundary download:',
              key,
              error instanceof Error ? error.message : 'failed',
            );
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (this.destroyed || this.requests.get(key) !== controller) return;
          this.requests.delete(key);
          this.trim();
          this.pump();
          this.changed();
        });
    }
  }
  destroy() {
    this.destroyed = true;
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    this.cache.clear();
  }
}

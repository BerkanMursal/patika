import type { Feeding, Park, Point } from './types';
import catalog from './parks.json';
import details from './park-details.json';
import { presentPark } from './park-names';
// Demonstration fixtures only. Never imported by production database migrations.
const positions = [
  ['Yoğurtçu Parkı', 'İstanbul', 'Kadıköy', 40.9878, 29.0326],
  ['Özgürlük Parkı', 'İstanbul', 'Kadıköy', 40.9787, 29.0588],
  ['Göztepe 60. Yıl Parkı', 'İstanbul', 'Kadıköy', 40.972, 29.063],
  ['Moda Sahil Parkı', 'İstanbul', 'Kadıköy', 40.9781, 29.0265],
  ['Maçka Demokrasi Parkı', 'İstanbul', 'Şişli', 41.0418, 28.9937],
  ['Gülhane Parkı', 'İstanbul', 'Fatih', 41.013, 28.9815],
  ['Kuğulu Park', 'Ankara', 'Çankaya', 39.9022, 32.8594],
  ['Kültürpark', 'İzmir', 'Konak', 38.4291, 27.143],
] as const;
const dates = [2, 14, 0.2, 4, 9, 1, 8, 3];
export function demoData() {
  const parks: Park[] = positions.map(([name, city, district, latitude, longitude], i) => ({
    id: `10000000-0000-4000-8000-00000000000${i}`,
    name,
    city,
    district,
    latitude,
    longitude,
    last_fed_at: i === 6 ? null : new Date(Date.now() - dates[i] * 86400000).toISOString(),
    last_grams: i === 6 ? null : [300, 500, 250, 200, 400, 150, 0, 600][i],
    last_water_at: i % 3 === 0 ? new Date(Date.now() - 7200000).toISOString() : null,
    total_records: i === 6 ? 0 : 1,
    food_status: i === 1 ? 'empty' : 'unknown',
    water_status: i === 1 ? 'empty' : 'unknown',
    observed_at: i === 1 ? new Date(Date.now() - 3600000).toISOString() : null,
  }));
  const points: Point[] = parks.map((p, i) => ({
    id: `20000000-0000-4000-8000-00000000000${i}`,
    park_id: p.id,
    name: 'Park içi genel nokta',
    latitude: p.latitude,
    longitude: p.longitude,
  }));
  const events: Feeding[] = parks
    .filter((p) => p.last_fed_at)
    .map((p, i) => ({
      id: `30000000-0000-4000-8000-00000000000${i}`,
      park_id: p.id,
      point_id: points.find((x) => x.park_id === p.id)!.id,
      user_id: 'demo-other',
      author_name: ['Deniz', 'Ece', 'Can', 'Selin'][i % 4],
      park_name: p.name,
      food_type: 'dry',
      food_grams: p.last_grams!,
      water_ml: p.last_water_at ? 500 : 0,
      occurred_at: p.last_fed_at!,
      note: 'Örnek besleme kaydı. Gerçek bir saha bildirimi değildir.',
      photo_path: '',
    }));
  const realParks: Park[] = catalog.map((row) =>
    presentPark({
      id: String(row[0]),
      osm_id: String(row[1]),
      name: String(row[2]),
      city: String(row[3]),
      district: String(row[4]),
      latitude: Number(row[5]),
      longitude: Number(row[6]),
      last_fed_at: null,
      last_grams: null,
      last_water_at: null,
      total_records: 0,
      food_status: 'unknown',
      water_status: 'unknown',
      observed_at: null,
      ...(details as Record<string, Partial<Park>>)[String(row[0])],
    }),
  );
  const remap = new Map<string, Park>();
  for (const sample of parks) {
    const named = realParks.filter(
      (p) =>
        p.city === sample.city &&
        p.name.toLocaleLowerCase('tr') === sample.name.toLocaleLowerCase('tr'),
    );
    let closest = realParks[0],
      distance = Infinity;
    for (const park of named.length ? named : realParks) {
      const d = (park.latitude - sample.latitude) ** 2 + (park.longitude - sample.longitude) ** 2;
      if (d < distance) {
        distance = d;
        closest = park;
      }
    }
    remap.set(sample.id, closest);
  }
  const samples = new Map(
    parks.map((p) => {
      const actual = remap.get(p.id)!;
      return [
        actual.id,
        {
          ...p,
          id: actual.id,
          osm_id: actual.osm_id,
          name: actual.name,
          name_status: actual.name_status,
          name_source: actual.name_source,
          name_source_url: actual.name_source_url,
          address_label: actual.address_label,
          city: actual.city,
          district: actual.district,
          latitude: actual.latitude,
          longitude: actual.longitude,
        },
      ];
    }),
  );
  return {
    parks: realParks.map((p) => samples.get(p.id) ?? p),
    points: realParks.map((p) => ({
      id: p.id,
      park_id: p.id,
      name: 'Park içi genel nokta',
      latitude: p.latitude,
      longitude: p.longitude,
    })),
    events: events.map((e) => {
      const actual = remap.get(e.park_id)!;
      return { ...e, park_id: actual.id, point_id: actual.id, park_name: actual.name };
    }),
  };
}

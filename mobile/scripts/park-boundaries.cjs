const osmtogeojson = require('osmtogeojson');

function tileKey(longitude, latitude) {
  return `${Math.floor(longitude * 4)}-${Math.floor(latitude * 4)}`;
}

function cleanRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const points = [];
  for (const point of ring) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !point.slice(0, 2).every(Number.isFinite) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) > 85
    )
      return null;
    const next = point.slice(0, 2).map((n) => Math.round(n * 1e6) / 1e6);
    const previous = points.at(-1);
    if (!previous || next[0] !== previous[0] || next[1] !== previous[1]) points.push(next);
  }
  const first = points[0],
    last = points.at(-1);
  if (
    points.length < 4 ||
    first[0] !== last[0] ||
    first[1] !== last[1] ||
    new Set(points.map((p) => p.join(','))).size < 3
  )
    return null;
  let area = 0;
  for (let i = 1; i < points.length; i++)
    area +=
      (points[i - 1][0] - first[0]) * (points[i][1] - first[1]) -
      (points[i][0] - first[0]) * (points[i - 1][1] - first[1]);
  return Math.abs(area) > 1e-12 ? points : null;
}

function cleanGeometry(geometry) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || !polygons.length) return null;
  const clean = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return null;
    const rings = polygon.map(cleanRing);
    // A broken hole must not turn into a filled area.
    if (rings.some((ring) => !ring)) return null;
    clean.push(rings);
  }
  return { type: geometry.type, coordinates: geometry.type === 'Polygon' ? clean[0] : clean };
}

function buildBoundaryTiles(source, catalog) {
  const byOsm = new Map(catalog.map((row) => [row[1], row]));
  const tiles = new Map(),
    ids = new Set();
  const stats = {
    catalogParks: catalog.length,
    boundaries: 0,
    polygons: 0,
    multipolygons: 0,
    withHoles: 0,
    skipped: 0,
  };
  const features = osmtogeojson(source, { flatProperties: false }).features;
  for (const feature of features) {
    const row = byOsm.get(feature.id);
    if (!row || ids.has(row[0])) continue;
    const geometry = !feature.properties.tainted && cleanGeometry(feature.geometry);
    if (!geometry) {
      stats.skipped++;
      continue;
    }
    const key = tileKey(row[6], row[5]);
    if (!tiles.has(key)) tiles.set(key, []);
    tiles
      .get(key)
      .push({ type: 'Feature', id: row[0], properties: { id: row[0], osm_id: row[1] }, geometry });
    ids.add(row[0]);
    stats.boundaries++;
    stats[geometry.type === 'Polygon' ? 'polygons' : 'multipolygons']++;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (polygons.some((polygon) => polygon.length > 1)) stats.withHoles++;
  }
  for (const features of tiles.values()) features.sort((a, b) => a.id.localeCompare(b.id));
  return { tiles, stats: { ...stats, withoutBoundary: catalog.length - ids.size } };
}

module.exports = { tileKey, cleanGeometry, buildBoundaryTiles };

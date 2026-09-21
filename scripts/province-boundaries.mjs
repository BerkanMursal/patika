import { readFile } from "node:fs/promises";

// Same [lon,lat] ring shape as polygon-geometry.mjs / park-enrichment.mjs's
// geometryIndex — provinces.geojson (ADM1) uses plain GeoJSON coordinates.
export async function loadProvinceRegions(path) {
  const geojson = JSON.parse(await readFile(path, "utf8"));

  return geojson.features.map(feature => {
    const polys =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;

    const coords = polys.flat(2);

    return {
      name: feature.properties.shapeName,
      polys,
      minX: Math.min(...coords.map(c => c[0])),
      maxX: Math.max(...coords.map(c => c[0])),
      minY: Math.min(...coords.map(c => c[1])),
      maxY: Math.max(...coords.map(c => c[1]))
    };
  });
}

export function officialProvinceNames(regions) {
  return new Set(regions.map(r => r.name));
}

function inRing(lon, lat, ring) {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];

    if (
      a[1] > lat !== b[1] > lat &&
      lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }

  return inside;
}

function containedBy(region, lon, lat) {
  if (
    lon < region.minX ||
    lon > region.maxX ||
    lat < region.minY ||
    lat > region.maxY
  ) {
    return false;
  }

  return region.polys.some(
    poly => inRing(lon, lat, poly[0]) && !poly.slice(1).some(hole => inRing(lon, lat, hole))
  );
}

// Point-in-polygon containment can fail for a park right at the coastline
// when the province polygon (geoBoundaries ADM1, already simplified for
// file size) is drawn slightly inside the true shoreline — the park is
// still unambiguously in that province, just outside the simplified
// boundary by a few meters to a few km. Distance-to-boundary is the
// deterministic, coordinate-based fallback for exactly that case; it is
// never used when containment already succeeds.
function metersPerLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

function pointSegmentDistanceMeters(lon, lat, a, b) {
  const lat0 = (lat + a[1] + b[1]) / 3;
  const mx = metersPerLon(lat0);
  const my = 110540;

  const px = lon * mx;
  const py = lat * my;
  const ax = a[0] * mx;
  const ay = a[1] * my;
  const bx = b[0] * mx;
  const by = b[1] * my;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;

  const denom = abx * abx + aby * aby;
  let t = denom === 0 ? 0 : (apx * abx + apy * aby) / denom;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

function distanceToRegionMeters(region, lon, lat) {
  let best = Infinity;

  for (const poly of region.polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const distance = pointSegmentDistanceMeters(lon, lat, ring[i], ring[i + 1]);
        if (distance < best) best = distance;
      }
    }
  }

  return best;
}

export function provincesContaining(regions, lon, lat) {
  return regions.filter(region => containedBy(region, lon, lat));
}

export function nearestProvince(regions, lon, lat) {
  let best = null;

  for (const region of regions) {
    const distance = distanceToRegionMeters(region, lon, lat);
    if (!best || distance < best.distance_m) {
      best = { name: region.name, distance_m: Math.round(distance) };
    }
  }

  return best;
}

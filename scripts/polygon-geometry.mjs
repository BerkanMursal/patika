// Representative-point helpers for GeoJSON polygons, adapted from the
// point-on-surface logic in scripts/build-izmir-canonical-v2.mjs (there
// applied to ArcGIS "rings"; here to GeoJSON [lon,lat] rings-with-holes,
// which is the same coordinate shape). A polygon's centroid can fall outside
// a concave/donut shape, so a random node or the raw centroid is not
// guaranteed to sit on the park itself — this always lands inside it.

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

export function pointInPolygonRings(lon, lat, rings) {
  const outer = rings?.[0];
  if (!outer || !inRing(lon, lat, outer)) return false;

  for (let i = 1; i < rings.length; i++) {
    if (inRing(lon, lat, rings[i])) return false;
  }

  return true;
}

function signedRingArea(ring) {
  let sum = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }

  return sum / 2;
}

function ringCentroid(ring) {
  let area2 = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const cross = x1 * y2 - x2 * y1;

    area2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }

  if (Math.abs(area2) < 1e-15) return null;
  return { lon: cx / (3 * area2), lat: cy / (3 * area2) };
}

export function pointOnSurface(rings) {
  const points = (rings ?? []).flat();
  if (!points.length) throw new Error("Polygon has no coordinates.");

  const minLon = Math.min(...points.map(p => p[0]));
  const maxLon = Math.max(...points.map(p => p[0]));
  const minLat = Math.min(...points.map(p => p[1]));
  const maxLat = Math.max(...points.map(p => p[1]));

  const centroid = ringCentroid(rings[0]);
  if (centroid && pointInPolygonRings(centroid.lon, centroid.lat, rings)) {
    return centroid;
  }

  const boxCenter = { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
  if (pointInPolygonRings(boxCenter.lon, boxCenter.lat, rings)) {
    return boxCenter;
  }

  let best = null;

  for (let step = 1; step < 80; step++) {
    const lat = minLat + (maxLat - minLat) * (step / 80);
    const intersections = [];

    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j];
        const b = ring[i];
        if (a[1] > lat === b[1] > lat) continue;

        const lon = a[0] + ((lat - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        intersections.push(lon);
      }
    }

    intersections.sort((a, b) => a - b);

    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const left = intersections[i];
      const right = intersections[i + 1];
      const width = right - left;
      const lon = (left + right) / 2;

      if (
        width > 0 &&
        pointInPolygonRings(lon, lat, rings) &&
        (!best || width > best.width)
      ) {
        best = { lon, lat, width };
      }
    }
  }

  if (best) return { lon: best.lon, lat: best.lat };
  throw new Error("Could not find point on polygon surface.");
}

// GeoJSON MultiPolygon coordinates: an array of polygon parts, each an
// array of rings (outer first, holes after). Disjoint parts (real
// multipolygon relations, e.g. a park split by a road) use the largest
// part by area as representative — same "largest wins" rule already used
// for İzmir's multi-polygon official clusters.
export function representativePoint(multiPolygonCoordinates) {
  let best = null;
  let bestArea = -Infinity;

  for (const rings of multiPolygonCoordinates) {
    const area = Math.abs(signedRingArea(rings[0]));
    if (area > bestArea) {
      bestArea = area;
      best = rings;
    }
  }

  if (!best) throw new Error("MultiPolygon has no parts.");
  return pointOnSurface(best);
}

export const clean = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
export const nameKey = (value) =>
  clean(value)
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]/g, "");
export const sourceName = (tags = {}) =>
  clean(tags["name:tr"]) ||
  clean(tags.name) ||
  clean(tags.official_name) ||
  clean(tags.loc_name);

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
export function geometryIndex(features) {
  return features.flatMap((feature) => {
    const { geometry } = feature;
    if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type))
      return [];
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    const coords = polygons.flat(2);
    return [
      {
        feature,
        polygons,
        minX: Math.min(...coords.map((c) => c[0])),
        maxX: Math.max(...coords.map((c) => c[0])),
        minY: Math.min(...coords.map((c) => c[1])),
        maxY: Math.max(...coords.map((c) => c[1])),
      },
    ];
  });
}
export function containing(index, longitude, latitude) {
  return index
    .filter(
      (r) =>
        longitude >= r.minX &&
        longitude <= r.maxX &&
        latitude >= r.minY &&
        latitude <= r.maxY &&
        r.polygons.some(
          (p) =>
            inRing(longitude, latitude, p[0]) &&
            !p.slice(1).some((hole) => inRing(longitude, latitude, hole)),
        ),
    )
    .map((r) => r.feature);
}
export function distanceMeters(a, b) {
  const rad = Math.PI / 180,
    dlat = (a.latitude - b.latitude) * rad,
    dlon = (a.longitude - b.longitude) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dlon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Both sides must have exactly one candidate in the small radius. No nearest-only
// match: adjacent parks and duplicate OSM geometries must remain unassigned.
export function uniquePointMatch(park, parks, candidates, radius = 25) {
  const near = candidates.filter((p) => distanceMeters(park, p) <= radius);
  if (near.length !== 1) return null;
  return parks.filter((p) => distanceMeters(p, near[0]) <= radius).length === 1
    ? near[0]
    : null;
}
export function parseCSV(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (c === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("Unclosed CSV field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const header = rows.shift()?.map((x) => x.replace(/^\uFEFF/, "")) ?? [];
  return rows
    .filter((r) => r.some(Boolean))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

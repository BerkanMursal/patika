import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { enrichCatalog } from "./enrich-catalog.mjs";
const data = new URL("../data/", import.meta.url),
  out = new URL("../mobile/src/core/parks.json", import.meta.url);
const source = JSON.parse(
  await readFile(new URL("parks-turkey.json", data), "utf8"),
);
let boundaries, metadata;
try {
  boundaries = JSON.parse(
    await readFile(new URL("provinces.geojson", data), "utf8"),
  );
  metadata = JSON.parse(
    await readFile(new URL("provinces-source.json", data), "utf8"),
  );
} catch {
  metadata = await (
    await fetch("https://www.geoboundaries.org/api/current/gbOpen/TUR/ADM1/", {
      signal: AbortSignal.timeout(30000),
    })
  ).json();
  const response = await fetch(metadata.simplifiedGeometryGeoJSON, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error("Province data unavailable");
  boundaries = await response.json();
  await writeFile(
    new URL("provinces.geojson", data),
    JSON.stringify(boundaries),
  );
  await writeFile(
    new URL("provinces-source.json", data),
    JSON.stringify(metadata, null, 2),
  );
}
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
const regions = boundaries.features.map((f) => {
  const polys =
    f.geometry.type === "Polygon"
      ? [f.geometry.coordinates]
      : f.geometry.coordinates;
  const coords = polys.flat(2);
  return {
    name: f.properties.shapeName,
    polys,
    minX: Math.min(...coords.map((c) => c[0])),
    maxX: Math.max(...coords.map((c) => c[0])),
    minY: Math.min(...coords.map((c) => c[1])),
    maxY: Math.max(...coords.map((c) => c[1])),
  };
});
function city(lon, lat) {
  return (
    regions.find(
      (r) =>
        lon >= r.minX &&
        lon <= r.maxX &&
        lat >= r.minY &&
        lat <= r.maxY &&
        r.polys.some(
          (poly) =>
            inRing(lon, lat, poly[0]) &&
            !poly.slice(1).some((h) => inRing(lon, lat, h)),
        ),
    )?.name ?? ""
  );
}
function id(value) {
  const bytes = createHash("sha256")
    .update(`patika-osm:${value}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const rows = source.elements.flatMap((e) => {
  const lat = e.lat ?? e.center?.lat,
    lon = e.lon ?? e.center?.lon;
  if (
    !Number.isFinite(lat) ||
    lat < 35 ||
    lat > 43 ||
    !Number.isFinite(lon) ||
    lon < 25 ||
    lon > 45
  )
    return [];
  const osm = `${e.type}/${e.id}`;
  return [
    [
      id(osm),
      osm,
      e.tags?.["name:tr"] || e.tags?.name || "İsimsiz park",
      city(lon, lat) || e.tags?.["addr:city"] || "",
      e.tags?.["addr:district"] || e.tags?.["addr:suburb"] || "",
      lat,
      lon,
    ],
  ];
});
await enrichCatalog(rows, source);
await writeFile(out, JSON.stringify(rows));
console.log(
  `Catalog: ${rows.length} parks; ${rows.filter((r) => r[3]).length} assigned to a province. Data snapshot: ${source.sourceTimestamp}`,
);

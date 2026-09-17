import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import boundaryTools from "../mobile/scripts/park-boundaries.cjs";

const root = new URL("../", import.meta.url);
const raw = await readFile(new URL("data/park-boundaries-osm.json", root));
const source = JSON.parse(raw);
const catalog = JSON.parse(
  await readFile(new URL("mobile/src/core/parks.json", root), "utf8"),
);
const { tiles, stats } = boundaryTools.buildBoundaryTiles(source, catalog);
if (!stats.boundaries)
  throw new Error("No valid park boundaries; published files unchanged.");
const out = new URL("mobile/public/data/park-boundaries/", root);
await mkdir(out, { recursive: true });
const manifest = {
  schema: 1,
  source: source.source,
  license: source.license,
  sourceUrl: source.sourceUrl,
  endpoint: source.endpoint,
  query: source.query,
  fetchedAt: source.fetchedAt,
  sourceTimestamp: source.sourceTimestamp,
  sourceSha256: createHash("sha256").update(raw).digest("hex"),
  transformations:
    "Exact OSM ID match; closed polygons and multipolygons only; inner holes retained; incomplete geometry rejected; coordinates rounded to 6 decimals. Tiles use catalog center on a 0.25 degree grid.",
  ...stats,
  tiles: {},
};
for (const [key, features] of [...tiles].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const text = JSON.stringify({ type: "FeatureCollection", features });
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const filename = `${key}-${hash}.json`;
  manifest.tiles[key] = {
    file: filename,
    count: features.length,
    bytes: Buffer.byteLength(text),
  };
  await writeFile(new URL(filename, out), text);
}
await writeFile(
  new URL("manifest.json", out),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  new URL("mobile/src/core/boundary-manifest.json", root),
  JSON.stringify(manifest) + "\n",
);
console.log(
  JSON.stringify({
    ...stats,
    tiles: tiles.size,
    bytes: Object.values(manifest.tiles).reduce((n, t) => n + t.bytes, 0),
  }),
);

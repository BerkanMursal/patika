import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const endpoint = "https://overpass.private.coffee/api/interpreter";
const catalog = JSON.parse(
  await readFile(
    new URL("../mobile/src/core/parks.json", import.meta.url),
    "utf8",
  ),
);
const requested = new Set(
  catalog.map((row) => row[1]).filter((id) => !id.startsWith("node/")),
);
const elements = [],
  timestamps = [];
const cacheRoot = new URL("../.local/boundary-download/", import.meta.url);
await mkdir(cacheRoot, { recursive: true });
let session = "";
if (process.argv.includes("--fresh")) {
  session = `snapshot-${Date.now()}`;
  await writeFile(new URL("active.txt", cacheRoot), session);
} else {
  try {
    session = (await readFile(new URL("active.txt", cacheRoot), "utf8")).trim();
  } catch {}
}
if (session && !/^snapshot-\d+$/.test(session))
  throw new Error("Invalid download cache session.");
const cache = session ? new URL(`${session}/`, cacheRoot) : cacheRoot;
await mkdir(cache, { recursive: true });
const cached = new Set();
for (const name of await readdir(cache)) {
  if (!name.endsWith(".json")) continue;
  const saved = JSON.parse(await readFile(new URL(name, cache), "utf8"));
  for (const element of saved.elements ?? []) {
    const id = `${element.type}/${element.id}`;
    if (requested.has(id) && !cached.has(id)) {
      cached.add(id);
      elements.push(element);
    }
  }
  if (saved.osm3s?.timestamp_osm_base)
    timestamps.push(saved.osm3s.timestamp_osm_base);
}
const records = [...requested].filter((id) => !cached.has(id));
console.log("Downloading OSM park polygons for Türkiye…");
console.log(`Reusing ${cached.size} cached records.`);
for (let offset = 0; offset < records.length; offset += 4000) {
  const batch = records.slice(offset, offset + 4000);
  const queries = ["way", "relation"].flatMap((type) => {
    const ids = batch
      .filter((id) => id.startsWith(type + "/"))
      .map((id) => id.split("/")[1]);
    return ids.length ? [`${type}(id:${ids.join(",")});`] : [];
  });
  const query = `[out:json][timeout:25][maxsize:67108864];(${queries.join("")});out geom;`;
  const file = new URL(
    createHash("sha256").update(query).digest("hex") + ".json",
    cache,
  );
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {}
  if (!raw) {
    let failure;
    for (const server of [
      "https://overpass-api.de/api/interpreter",
      endpoint,
    ]) {
      try {
        const started = Date.now();
        const response = await fetch(server, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent":
              "PatikaParkImport/1.0 (+https://patika-project.vercel.app)",
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok)
          throw new Error(
            `Boundary source returned ${response.status}; cache unchanged.`,
          );
        raw = await response.json();
        if (raw.remark || !Array.isArray(raw.elements) || !raw.elements.length)
          throw new Error(
            `Boundary query incomplete: ${raw.remark ?? "empty result"}; cache unchanged.`,
          );
        await writeFile(file, JSON.stringify(raw));
        console.log(
          `Source ${new URL(server).hostname}: ${Math.round((Date.now() - started) / 1000)}s`,
        );
        break;
      } catch (error) {
        failure = error;
        raw = undefined;
      }
    }
    if (!raw) throw failure;
  }
  elements.push(...raw.elements);
  timestamps.push(raw.osm3s?.timestamp_osm_base);
  console.log(
    `${cached.size + Math.min(offset + 4000, records.length)}/${requested.size} park records downloaded.`,
  );
}
const document = {
  source: "OpenStreetMap contributors",
  license: "ODbL-1.0",
  sourceUrl: "https://www.openstreetmap.org/copyright",
  endpoint: ["https://overpass-api.de/api/interpreter", endpoint],
  query:
    "Known catalog OSM IDs, batches of up to 4000; (way(id:...);relation(id:...););out geom;",
  fetchedAt: new Date().toISOString(),
  sourceTimestamp: { first: timestamps.sort()[0], last: timestamps.at(-1) },
  elements,
};
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../data/park-boundaries-osm.json", import.meta.url),
  JSON.stringify(document),
);
console.log(`Downloaded ${elements.length} OSM ways/relations.`);

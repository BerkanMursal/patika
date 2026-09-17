import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const folder = new URL("../data/park-enrichment/", import.meta.url);
const manifestURL = new URL("sources.json", folder);
const manifest = JSON.parse(await readFile(manifestURL, "utf8"));
// Download all required sources first. A failed provider keeps every existing
// snapshot intact; do not publish a mixture of successful and failed downloads.
const downloads = await Promise.all(
  manifest.sources.map(async (source) => {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`${source.file}: HTTP ${response.status}`);
    const body = await response.text();
    if (source.file.endsWith(".json") || source.file.endsWith(".geojson")) {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.features) || !parsed.features.length)
        throw new Error(`Invalid geometry: ${source.file}`);
    } else if (!body.includes("PARK_ADI") || !body.includes("ADRES"))
      throw new Error(`Invalid CSV: ${source.file}`);
    return {
      source,
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }),
);
for (const item of downloads) {
  await writeFile(new URL(item.source.file, folder), item.body);
  item.source.sha256 = item.sha256;
}
manifest.fetchedAt = new Date().toISOString();
await writeFile(manifestURL, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  "Park source snapshots refreshed. Run node scripts/build-catalog.mjs and review the enrichment diff before importing or deploying.",
);

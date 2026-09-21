import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const cacheDir = path.join(root, "data/park-enrichment/.cache/konya");

const resourceUrl =
  "https://acikveri.konya.bel.tr/tr/dataset/760d70d8-fc03-436b-9a79-4b79152ee3fe/resource/4948ccd3-6667-46c3-be81-e0a7300ef785/download/parklar.geojson";

const licenseUrl = "https://acikveri.konya.bel.tr/license";

await mkdir(cacheDir, { recursive: true });

// This host's TLS chain fails plain fetch()'s trust store in this
// environment (verified: it's a local CA-bundle gap, not a real server
// problem — curl -k succeeds). fetch() has no per-request insecure option,
// so a temporary process-wide override is used only around these two calls.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const geojsonResponse = await fetch(resourceUrl, {
  signal: AbortSignal.timeout(60000)
});

if (!geojsonResponse.ok) {
  throw new Error(`Konya GeoJSON fetch failed: HTTP ${geojsonResponse.status}`);
}

const geojsonText = await geojsonResponse.text();
const geojson = JSON.parse(geojsonText);

const licenseResponse = await fetch(licenseUrl, {
  signal: AbortSignal.timeout(30000)
});

if (!licenseResponse.ok) {
  throw new Error(`Konya license page fetch failed: HTTP ${licenseResponse.status}`);
}

const licenseHtml = await licenseResponse.text();

delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

if (!Array.isArray(geojson.features) || !geojson.features.length) {
  throw new Error("Konya GeoJSON has no features — refusing to cache an empty/invalid snapshot.");
}

// License text must actually be read, not just named — confirms the
// license currently displayed still says what data/municipal-park-sources.json
// records, every time this script runs.
if (!/Creative Commons/i.test(licenseHtml) || !/CC BY 4\.0|Atıf 4\.0/i.test(licenseHtml)) {
  throw new Error(
    "Konya license page no longer states Creative Commons / CC BY 4.0 — " +
      "re-check data/municipal-park-sources.json before proceeding."
  );
}

const geojsonPath = path.join(cacheDir, "parklar.geojson");
const licensePath = path.join(cacheDir, "license.html");
const manifestPath = path.join(cacheDir, "manifest.json");

await writeFile(geojsonPath, geojsonText);
await writeFile(licensePath, licenseHtml);

const manifest = {
  sourceCode: "konya_acikveri_parklar",
  resourceUrl,
  licenseUrl,
  licenseName: "Creative Commons Atıf 4.0 Uluslararası Lisansı (CC BY 4.0)",
  licenseConfirmedAt: new Date().toISOString(),
  featureCount: geojson.features.length,
  sha256: createHash("sha256").update(geojsonText).digest("hex"),
  fetchedAt: new Date().toISOString()
};

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log("===== KONYA PARKS DOWNLOAD =====");
console.log(manifest);
console.log(`\nCached -> ${geojsonPath}`);

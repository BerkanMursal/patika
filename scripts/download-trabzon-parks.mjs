import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const cacheDir = path.join(root, "data/park-enrichment/.cache/trabzon");

// Exact resource_url from data/municipal-park-sources.json's
// trabzon_acikveri_parklar entry, re-verified by direct curl fetch
// 2026-09-21 (57 features, Point geometry, OBJECTID+ADI only).
const resourceUrl =
  "https://acikveri.trabzon.bel.tr/dataset/ed40a618-1a58-4879-a77f-4c0219aaa9a9/resource/394ec651-8d36-45e7-9e4c-bfa3853b8fae/download/park.geojson";

const licenseUrl = "https://acikveri.trabzon.bel.tr/license";

await mkdir(cacheDir, { recursive: true });

// Same local CA-trust-store gap documented for Konya/Ordu/Balıkesir —
// curl -k and this scoped override both confirm it's not a server problem.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const geojsonResponse = await fetch(resourceUrl, {
  signal: AbortSignal.timeout(60000)
});

if (!geojsonResponse.ok) {
  throw new Error(`Trabzon GeoJSON fetch failed: HTTP ${geojsonResponse.status}`);
}

const geojsonText = await geojsonResponse.text();
const geojson = JSON.parse(geojsonText);

const licenseResponse = await fetch(licenseUrl, {
  signal: AbortSignal.timeout(30000)
});

if (!licenseResponse.ok) {
  throw new Error(`Trabzon license page fetch failed: HTTP ${licenseResponse.status}`);
}

const licenseHtml = await licenseResponse.text();

delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

if (!Array.isArray(geojson.features) || !geojson.features.length) {
  throw new Error("Trabzon GeoJSON has no features — refusing to cache an empty/invalid snapshot.");
}

// Same ULASAV boilerplate already confirmed for Ordu/Balıkesir.
if (!/Aşağıdakileri yapmakta özgürsünüz/i.test(licenseHtml)) {
  throw new Error(
    "Trabzon license page no longer states the expected ULASAV open-license terms — " +
      "re-check data/municipal-park-sources.json before proceeding."
  );
}

const geojsonPath = path.join(cacheDir, "parklar.geojson");
const licensePath = path.join(cacheDir, "license.html");
const manifestPath = path.join(cacheDir, "manifest.json");

await writeFile(geojsonPath, geojsonText);
await writeFile(licensePath, licenseHtml);

const manifest = {
  sourceCode: "trabzon_acikveri_parklar",
  resourceUrl,
  licenseUrl,
  licenseName: "Trabzon Açık Veri Lisansı (ULASAV template — same terms as Ordu/Balıkesir, confirmed by direct fetch)",
  licenseConfirmedAt: new Date().toISOString(),
  featureCount: geojson.features.length,
  sha256: createHash("sha256").update(geojsonText).digest("hex"),
  fetchedAt: new Date().toISOString()
};

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log("===== TRABZON PARKS DOWNLOAD =====");
console.log(manifest);
console.log(`\nCached -> ${geojsonPath}`);

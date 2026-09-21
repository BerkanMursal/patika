import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const cacheDir = path.join(root, "data/park-enrichment/.cache/ordu");

const resourceUrl =
  "https://acikveri.ordu.bel.tr/dataset/ec6b41cc-c423-49cb-ad62-a821f92d7dc1/resource/31e2e9ac-8998-4c42-a0ad-33f1f5eefb2a/download/ordu_buyukehir_parklar.geojson";

const licenseUrl = "https://acikveri.ordu.bel.tr/license";

await mkdir(cacheDir, { recursive: true });

// Same local CA-trust-store gap documented for Konya/Trabzon/Balıkesir —
// curl -k and this scoped override both confirm it's not a server problem.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const geojsonResponse = await fetch(resourceUrl, {
  signal: AbortSignal.timeout(60000)
});

if (!geojsonResponse.ok) {
  throw new Error(`Ordu GeoJSON fetch failed: HTTP ${geojsonResponse.status}`);
}

const geojsonText = await geojsonResponse.text();
const geojson = JSON.parse(geojsonText);

const licenseResponse = await fetch(licenseUrl, {
  signal: AbortSignal.timeout(30000)
});

if (!licenseResponse.ok) {
  throw new Error(`Ordu license page fetch failed: HTTP ${licenseResponse.status}`);
}

const licenseHtml = await licenseResponse.text();

delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

if (!Array.isArray(geojson.features) || !geojson.features.length) {
  throw new Error("Ordu GeoJSON has no features — refusing to cache an empty/invalid snapshot.");
}

// Ordu's platform doesn't name "Creative Commons" explicitly on the page in
// the same way Konya's does; it uses the same ULASAV boilerplate as
// Trabzon/Balıkesir. Check for that template instead.
if (!/Aşağıdakileri yapmakta özgürsünüz/i.test(licenseHtml)) {
  throw new Error(
    "Ordu license page no longer states the expected ULASAV open-license terms — " +
      "re-check data/municipal-park-sources.json before proceeding."
  );
}

const geojsonPath = path.join(cacheDir, "parklar.geojson");
const licensePath = path.join(cacheDir, "license.html");
const manifestPath = path.join(cacheDir, "manifest.json");

await writeFile(geojsonPath, geojsonText);
await writeFile(licensePath, licenseHtml);

const manifest = {
  sourceCode: "ordu_acikveri_parklari",
  resourceUrl,
  licenseUrl,
  licenseName: "Ordu Açık Veri Lisansı (ULASAV template — same terms as Trabzon/Balıkesir, confirmed by direct fetch)",
  licenseConfirmedAt: new Date().toISOString(),
  featureCount: geojson.features.length,
  sha256: createHash("sha256").update(geojsonText).digest("hex"),
  fetchedAt: new Date().toISOString()
};

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log("===== ORDU PARKS DOWNLOAD =====");
console.log(manifest);
console.log(`\nCached -> ${geojsonPath}`);

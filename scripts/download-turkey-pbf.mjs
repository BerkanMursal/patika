import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Geofabrik's "-latest" alias 302-redirects to a dated snapshot
// (turkey-YYMMDD.osm.pbf). That resolved, dated filename plus its published
// MD5 is our reproducibility anchor — not "-latest" itself, which is a
// moving pointer.
const LATEST_URL =
  "https://download.geofabrik.de/europe/turkey-latest.osm.pbf";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const cacheDir = path.join(
  root,
  "data/park-enrichment/.cache/geofabrik"
);

const manifestPath = path.join(cacheDir, "manifest.json");

await mkdir(cacheDir, { recursive: true });

const head = await fetch(LATEST_URL, {
  method: "HEAD",
  signal: AbortSignal.timeout(30000)
});

if (!head.ok) {
  throw new Error(`Geofabrik HEAD ${head.status} for ${LATEST_URL}`);
}

const resolvedUrl = head.url;
const resolvedFilename = resolvedUrl.split("/").pop();
const lastModified = head.headers.get("last-modified");
const expectedSize = Number(head.headers.get("content-length")) || null;

const md5Response = await fetch(`${resolvedUrl}.md5`, {
  signal: AbortSignal.timeout(30000)
});

if (!md5Response.ok) {
  throw new Error(
    `Geofabrik checksum unavailable (HTTP ${md5Response.status}) for ${resolvedFilename}`
  );
}

const md5Line = (await md5Response.text()).trim();
const expectedMd5 = md5Line.split(/\s+/)[0];

if (!/^[0-9a-f]{32}$/i.test(expectedMd5)) {
  throw new Error(`Unexpected checksum format: ${md5Line}`);
}

const pbfPath = path.join(cacheDir, resolvedFilename);

async function md5OfFile(filePath) {
  const buffer = await readFile(filePath);
  return createHash("md5").update(buffer).digest("hex");
}

async function alreadyCached() {
  try {
    const info = await stat(pbfPath);
    if (expectedSize && info.size !== expectedSize) return false;
    return (await md5OfFile(pbfPath)) === expectedMd5.toLowerCase();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const summary = {
  sourceUrl: LATEST_URL,
  resolvedUrl,
  resolvedFilename,
  expectedMd5,
  expectedSize,
  lastModified,
  cachePath: pbfPath
};

if (await alreadyCached()) {
  console.log("===== TURKEY PBF — ALREADY CACHED =====");
  console.log({ ...summary, downloaded: false });
} else {
  console.log("===== TURKEY PBF — DOWNLOADING =====");
  console.log(summary);

  const tmpPath = `${pbfPath}.download`;
  const response = await fetch(resolvedUrl, {
    signal: AbortSignal.timeout(600000)
  });

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  await writeFile(tmpPath, Buffer.from(await response.arrayBuffer()));

  const actualMd5 = await md5OfFile(tmpPath);
  if (actualMd5.toLowerCase() !== expectedMd5.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for ${resolvedFilename}: expected ${expectedMd5}, got ${actualMd5}. ` +
        `Left the corrupt download at ${tmpPath} for inspection.`
    );
  }

  await rename(tmpPath, pbfPath);
  console.log("Checksum verified.");
}

const manifest = {
  ...summary,
  fetchedAt: new Date().toISOString(),
  license: "ODbL-1.0",
  attribution: "© OpenStreetMap contributors, via Geofabrik",
  licenseUrl: "https://www.openstreetmap.org/copyright"
};

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`\nManifest -> ${manifestPath}`);
console.log(`PBF cached at -> ${pbfPath}`);

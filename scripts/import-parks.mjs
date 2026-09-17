import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "mobile/package.json"));
const { createClient } = require("@supabase/supabase-js");
const cache = path.join(root, "data/parks-turkey.json");
let document;
if (process.argv.includes("--download")) {
  const query =
    '[out:json][timeout:180];area["ISO3166-1"="TR"][admin_level=2]->.tr;nwr[leisure=park](area.tr);out tags center;';
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "PatikaParkImport/1.0 (+https://patika-project.vercel.app)",
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(210000),
  });
  if (!response.ok)
    throw new Error(
      `Park source returned ${response.status}; no import was attempted.`,
    );
  const raw = await response.json();
  if (raw.remark) throw new Error(`Source query incomplete: ${raw.remark}`);
  document = {
    source: "OpenStreetMap contributors",
    license: "ODbL-1.0",
    sourceUrl: "https://www.openstreetmap.org/copyright",
    fetchedAt: new Date().toISOString(),
    sourceTimestamp: raw.osm3s?.timestamp_osm_base,
    elements: raw.elements,
  };
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify(document));
} else document = JSON.parse(await readFile(cache, "utf8"));
const catalog = JSON.parse(
  await readFile(path.join(root, "mobile/src/core/parks.json"), "utf8"),
);
const details = JSON.parse(
  await readFile(path.join(root, "mobile/src/core/park-details.json"), "utf8"),
);
const byOsm = new Map(catalog.map((r) => [r[1], r]));
const parks = document.elements
  .map((e) => ({
    osm_id: `${e.type}/${e.id}`,
    name: e.tags?.["name:tr"] || e.tags?.name || "İsimsiz park",
    city: e.tags?.["addr:city"] || "",
    district: e.tags?.["addr:district"] || e.tags?.["addr:suburb"] || "",
    latitude: e.lat ?? e.center?.lat,
    longitude: e.lon ?? e.center?.lon,
    source: "OpenStreetMap",
    imported_at: document.fetchedAt,
  }))
  .filter(
    (p) =>
      Number.isFinite(p.latitude) &&
      Number.isFinite(p.longitude) &&
      p.latitude >= 35 &&
      p.latitude <= 43 &&
      p.longitude >= 25 &&
      p.longitude <= 45,
  );
console.log(
  `${parks.length} park records; source snapshot ${document.sourceTimestamp}. Coverage is not a guarantee of every park in Türkiye.`,
);
if (process.argv.includes("--download-only")) process.exit(0);
const url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key)
  throw new Error(
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your private shell environment. Never use EXPO_PUBLIC_ for an admin key.",
  );
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
for (let i = 0; i < parks.length; i += 200) {
  const { data, error } = await client
    .from("parks")
    .upsert(
      parks.slice(i, i + 200).map((p) => {
        const row = byOsm.get(p.osm_id);
        if (!row)
          throw new Error("Rebuild the catalog before importing newer data.");
        return {
          ...p,
          id: row[0],
          name: row[2],
          city: row[3] || p.city,
          district: row[4],
          name_status: row[2] === "İsimsiz park" ? "missing" : "source",
          name_source: "OpenStreetMap",
          name_source_url: `https://www.openstreetmap.org/${p.osm_id}`,
          address_label: "",
          ...details[row[0]],
        };
      }),
      { onConflict: "osm_id" },
    )
    .select("id,latitude,longitude");
  if (error) throw error;
  const points = (data ?? []).map((p) => ({
    id: p.id,
    park_id: p.id,
    name: "Park içi genel nokta",
    latitude: p.latitude,
    longitude: p.longitude,
  }));
  const { error: pointsError } = await client
    .from("feeding_points")
    .upsert(points, { onConflict: "park_id,name", ignoreDuplicates: true });
  if (pointsError) throw pointsError;
  console.log(`Imported ${Math.min(i + 200, parks.length)}/${parks.length}`);
}

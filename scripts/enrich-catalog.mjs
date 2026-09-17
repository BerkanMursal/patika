import { readFile, writeFile } from "node:fs/promises";
import {
  clean,
  nameKey,
  sourceName,
  geometryIndex,
  containing,
  uniquePointMatch,
  parseCSV,
} from "./park-enrichment.mjs";
const folder = new URL("../data/park-enrichment/", import.meta.url);
const json = async (name) =>
  JSON.parse(await readFile(new URL(name, folder), "utf8"));
const kadikoyURL = "https://acikveri.kadikoy.bel.tr/dataset/kadikoy-yesil-alan";

export async function enrichCatalog(rows, source) {
  const districts = geometryIndex((await json("districts.geojson")).features);
  const polygons = geometryIndex(
    (await json("kadikoy-polygons.json")).features,
  );
  const points = (await json("kadikoy-points.json")).features.map((f) => ({
    name: clean(f.properties["Açık_ve_"]),
    neighborhood: clean(f.properties.Mahalle),
    latitude: f.geometry.coordinates[1],
    longitude: f.geometry.coordinates[0],
  }));
  const tagsById = new Map(
    source.elements.map((e) => [`${e.type}/${e.id}`, e.tags ?? {}]),
  );
  const parks = rows.map((row) => ({
    row,
    latitude: row[5],
    longitude: row[6],
  }));
  const istanbul = parks.filter((p) => p.row[3] === "İstanbul");
  const polygonMembership = new Map(
    istanbul.map((p) => [
      p.row[0],
      containing(polygons, p.longitude, p.latitude),
    ]),
  );
  const polygonCounts = new Map();
  for (const matches of polygonMembership.values())
    for (const f of matches)
      polygonCounts.set(f, (polygonCounts.get(f) ?? 0) + 1);
  const izmir = (
    await Promise.all(
      ["izmir-north.csv", "izmir-south.csv"].map(async (file) =>
        parseCSV(await readFile(new URL(file, folder), "utf8")),
      ),
    )
  ).flat();
  const izmirParks = parks.filter((p) => p.row[3] === "İzmir");
  const details = {};
  const stats = {
    total: rows.length,
    namedBefore: rows.filter((r) => r[2] !== "İsimsiz park").length,
    namesAdded: 0,
    districtsAdded: 0,
    addressLabels: 0,
    municipalAddresses: 0,
  };
  for (const park of parks) {
    const row = park.row,
      tags = tagsById.get(row[1]);
    const name = sourceName(tags);
    row[2] = name || "İsimsiz park";
    if (!row[4]) {
      const matches = containing(districts, park.longitude, park.latitude);
      if (matches.length === 1) {
        row[4] = clean(matches[0].properties.shapeName);
        stats.districtsAdded++;
      }
    }
    const detail = {
      address_label: [tags["addr:neighbourhood"], tags["addr:street"]]
        .map(clean)
        .filter(Boolean)
        .join(" · "),
    };
    if (row[3] === "İstanbul") {
      const contained = polygonMembership.get(row[0]) ?? [];
      const polygon =
        contained.length === 1 && polygonCounts.get(contained[0]) === 1
          ? contained[0]
          : null;
      const point = uniquePointMatch(park, istanbul, points);
      // Conflicting point/polygon names are left for a human to verify.
      const candidate =
        polygon &&
        (!point || nameKey(point.name) === nameKey(polygon.properties.adi))
          ? clean(polygon.properties.adi)
          : !contained.length
            ? point?.name
            : "";
      if (!name && candidate) {
        row[2] = candidate;
        stats.namesAdded++;
        Object.assign(detail, {
          name_status: "municipal",
          name_source: "Kadıköy Belediyesi",
          name_source_url: kadikoyURL,
        });
      }
      if (
        point?.neighborhood &&
        (!name || nameKey(name) === nameKey(point.name))
      ) {
        detail.address_label ||= `${point.neighborhood} Mahallesi`;
        stats.municipalAddresses++;
      }
    }
    if (row[3] === "İzmir" && name) {
      const candidates = izmir.filter(
        (r) =>
          nameKey(r.PARK_ADI) === nameKey(name) &&
          nameKey(r.ILCE) === nameKey(row[4]),
      );
      if (
        candidates.length === 1 &&
        izmirParks.filter(
          (p) =>
            nameKey(p.row[2]) === nameKey(name) &&
            nameKey(p.row[4]) === nameKey(row[4]),
        ).length === 1
      ) {
        detail.address_label ||= [
          clean(candidates[0].MAHALLE),
          clean(candidates[0].ADRES),
        ]
          .filter(Boolean)
          .join(" · ");
        stats.municipalAddresses++;
      }
    }
    if (detail.address_label) stats.addressLabels++;
    if (detail.address_label || detail.name_status) details[row[0]] = detail;
  }
  await writeFile(
    new URL("../mobile/src/core/park-details.json", import.meta.url),
    JSON.stringify(details),
  );
  await writeFile(
    new URL("../mobile/src/core/enrichment-sources.json", import.meta.url),
    await readFile(new URL("sources.json", folder), "utf8"),
  );
  await writeFile(
    new URL("../data/park-enrichment/summary.json", import.meta.url),
    JSON.stringify(
      {
        ...stats,
        namedAfter: rows.filter((r) => r[2] !== "İsimsiz park").length,
        method:
          "Unique polygon containment or reciprocal unique point within 25 m; existing names preserved. İzmir address: unique exact normalized name and district. Districts: unique polygon containment, 2021 boundary snapshot.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(stats));
  return rows;
}

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const at = (path) => fileURLToPath(new URL(path, import.meta.url));
await mkdir(at('../dist/data'), { recursive: true });
await copyFile(at('../src/core/parks.json'), at('../dist/data/parks.json'));
await copyFile(at('../src/core/park-details.json'), at('../dist/data/park-details.json'));
await copyFile(
  at('../src/core/enrichment-sources.json'),
  at('../dist/data/enrichment-sources.json'),
);
await writeFile(
  at('../dist/data/README.txt'),
  `Patika park catalog — snapshot 2026-09-13
Fields per row: id, osm_id, name, city, district, latitude, longitude.
Additional fields by park UUID: /data/park-details.json (address_label, name_status, name_source, name_source_url).
Park boundary polygons: /data/park-boundaries/manifest.json lists geographic tile files and coverage.
Boundary geometry: OpenStreetMap ways/relations matched by exact OSM ID; valid closed polygons and multipolygons, including inner holes; coordinates rounded to 6 decimal places.
Boundaries have a separate snapshot timestamp in their manifest and remain ODbL 1.0.
Source URLs, licenses and snapshot hashes: /data/enrichment-sources.json.
Park data: © OpenStreetMap contributors, ODbL 1.0.
https://www.openstreetmap.org/copyright
https://opendatacommons.org/licenses/odbl/1-0/
Province assignment: geoBoundaries TUR ADM1, boundaryID TUR-ADM1-25984515 (2021 boundaries).
Metadata license: CC BY-SA 2.0; source OpenStreetMap via geoBoundaries.
https://www.geoboundaries.org/api/current/gbOpen/TUR/ADM1/
https://creativecommons.org/licenses/by-sa/2.0/
24,669 source features. Coverage, names and geometry may be incomplete or duplicated.
10 missing names completed from Kadıköy Belediyesi park geometry/points (CC BY 4.0).
https://acikveri.kadikoy.bel.tr/dataset/kadikoy-yesil-alan
Addresses additionally matched from İzmir Büyükşehir Belediyesi park lists (CC BY 4.0).
https://acikveri.bizizmir.com/tr/dataset/kuzey-guney-alani-park-sayilari
https://creativecommons.org/licenses/by/4.0/
District assignment: geoBoundaries TUR-ADM2-54988432, 2021 snapshot; source OSM Boundaries, ODbL 1.0.
https://www.geoboundaries.org/api/current/gbOpen/TUR/ADM2/
Derived data: normalized whitespace; conservative geometry/name matches; source names preserved.
Unmatched names are not invented: the app displays a stable park code and available location details.
City is inferred from simplified province boundaries where a source tag is absent.
Feeding events are not included. UUIDs are deterministic internal identifiers.
`,
);

import { readFile, writeFile } from "node:fs/promises";
import { distanceMeters } from "./park-enrichment.mjs";
import { strongNameEvidence } from "./name-evidence.mjs";

// READ-ONLY near-duplicate audit over the merged nationwide preview. Flags
// municipal-only parks (grouped by their municipal source) that look like
// another canonical park. Never modifies data.
const cacheRoot = new URL("../data/park-enrichment/.cache/", import.meta.url);
const path = process.argv[2] ?? "nationwide-canonical-preview.json";
const data = JSON.parse(await readFile(new URL(path, cacheRoot), "utf8"));
const parks = data.parks;

const CELL = 0.004; // ~440 m
const grid = new Map();
const key = (la, lo) => `${Math.floor(la / CELL)}:${Math.floor(lo / CELL)}`;
for (const p of parks) { const k = key(p.latitude, p.longitude); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
function near(p, r) {
  const ci = Math.floor(p.latitude / CELL), cj = Math.floor(p.longitude / CELL), out = [];
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
    for (const q of grid.get(`${i}:${j}`) ?? []) {
      if (q === p) continue;
      const d = distanceMeters(p, q); if (d <= r) out.push({ q, d });
    }
  return out;
}
const sourceOf = p => (p.source_refs?.[0]?.source_code) ?? "(none)";
const munOnly = parks.filter(p => !p.osm_id);
const perSource = {};
const S = c => (perSource[c] ??= { municipalOnly: 0, strongName250: new Set(), strongName150: new Set(), veryClose30SameSource: new Set(), veryClose30AnyCanonical: new Set(), samples: [] });
for (const p of munOnly) {
  const s = S(sourceOf(p)); s.municipalOnly++;
  for (const { q, d } of near(p, 250)) {
    const ev = strongNameEvidence(p.name, q.name);
    if (ev) { s.strongName250.add(p.id); if (d <= 150) s.strongName150.add(p.id); if (s.samples.length < 12) s.samples.push({ a: p.name, b: q.name, b_src: q.osm_id ? "osm" : sourceOf(q), d: Math.round(d), ev: ev.kind }); }
    if (d <= 30) {
      s.veryClose30AnyCanonical.add(p.id);
      if (!q.osm_id && sourceOf(q) === sourceOf(p)) s.veryClose30SameSource.add(p.id);
    }
  }
}
// canonical parks carrying >1 ref from the same source (distinct records -> same park)
const multiRef = {};
for (const p of parks) {
  const c = {}; for (const r of p.source_refs ?? []) c[r.source_code] = (c[r.source_code] ?? 0) + 1;
  for (const [k, n] of Object.entries(c)) if (n > 1) multiRef[k] = (multiRef[k] ?? 0) + 1;
}
const report = Object.fromEntries(Object.entries(perSource).map(([k, v]) => [k, {
  municipalOnly: v.municipalOnly, strongNameWithin250: v.strongName250.size, strongNameWithin150: v.strongName150.size,
  within30mOfAnyCanonical: v.veryClose30AnyCanonical.size, within30mSameSourceMunicipalOnly: v.veryClose30SameSource.size, samples: v.samples }]));
const out = { source_file: path, totalParks: parks.length, perSource: report, canonicalWithMultipleRefsFromSameSource: multiRef };
await writeFile(new URL("municipal-near-duplicate-audit.json", cacheRoot), JSON.stringify(out, null, 2));
for (const [k, v] of Object.entries(report)) console.log(k.padEnd(40), JSON.stringify({ ...v, samples: undefined }));
console.log("multi-ref same source:", JSON.stringify(multiRef));

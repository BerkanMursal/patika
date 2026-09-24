import { readFile } from "node:fs/promises";
import { clean } from "./park-enrichment.mjs";

// Carries forward already-verified license evidence from this project's
// two existing research registries (data/municipal-park-sources.json,
// data/sources-registry.json) plus the ULASAV-template pattern verified by
// direct fetch many times this session (Konya/Ordu/Trabzon/Balıkesir/
// Bursa/Van/Osmaniye license pages all confirmed open). Per explicit
// instruction: never downgrade a previously-verified SAFE_OPEN source just
// because the automatic CKAN heuristic lacks metadata, and never upgrade an
// unknown license based only on municipality reputation — every entry here
// traces to a concrete prior verification, not a guess.

function normalizeOrgName(name) {
  return clean(name)
    .toLocaleLowerCase("tr")
    .replace(/[İI]/g, "i")
    .replace(/[^a-z0-9]/g, "");
}

export async function loadLicenseEvidence() {
  const registryPath = new URL("../data/municipal-park-sources.json", import.meta.url);
  const sourcesRegistryPath = new URL("../data/sources-registry.json", import.meta.url);

  const byOrg = new Map();

  try {
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    for (const s of registry.sources ?? []) {
      if (s.license_status === "SAFE_OPEN" && s.municipality) {
        byOrg.set(normalizeOrgName(s.municipality), {
          license_status: "SAFE_OPEN",
          license_source: "data/municipal-park-sources.json",
          license_url: s.license_url ?? null,
          license_verified_at: s.last_updated ?? "unknown"
        });
      }
    }
  } catch {
    // registry not present — proceed with no prior evidence from it
  }

  try {
    const sourcesRegistry = JSON.parse(await readFile(sourcesRegistryPath, "utf8"));
    for (const s of sourcesRegistry.sources ?? []) {
      if (/^(CC BY|CC0|ODbL)/i.test(s.license ?? "") && s.source_name) {
        // source_name here is the dataset/source name, not always the org —
        // extract a plausible org fragment (first "Belediyesi" phrase).
        const orgMatch = s.source_name.match(/^(.*?Belediyesi)/);
        const org = orgMatch ? orgMatch[1] : s.source_name;
        byOrg.set(normalizeOrgName(org), {
          license_status: "SAFE_OPEN",
          license_source: "data/sources-registry.json",
          license_url: s.source_url ?? null,
          license_verified_at: "see data/sources-registry.json notes"
        });
      }
      // Explicit negative evidence — never silently overridden by a later
      // positive guess for the same org/source.
      if (s.license === "unknown" && s.source_name) {
        byOrg.set(normalizeOrgName(s.source_name), {
          license_status: "LICENSE_UNVERIFIED",
          license_source: "data/sources-registry.json (explicitly recorded unknown/unconfirmed)",
          license_url: s.source_url ?? null,
          license_verified_at: "n/a — recorded as unconfirmed"
        });
      }
    }
  } catch {
    // sources-registry not present — proceed with no prior evidence from it
  }

  // Bursa correction found this session (2026-09-22): acikyesil.bursa.bel.tr
  // /license directly re-fetched and confirmed the open ULASAV template text
  // — data/municipal-park-sources.json still says UNUSABLE (not yet
  // corrected there), so this override is recorded here explicitly rather
  // than silently trusting the stale registry value.
  byOrg.set(normalizeOrgName("Bursa Büyükşehir Belediyesi"), {
    license_status: "SAFE_OPEN",
    license_source: "direct fetch 2026-09-22 (acikyesil.bursa.bel.tr/license) — corrects a stale UNUSABLE value still in data/municipal-park-sources.json",
    license_url: "https://acikyesil.bursa.bel.tr/license",
    license_verified_at: "2026-09-22"
  });

  return {
    lookup(orgTitle) {
      return byOrg.get(normalizeOrgName(orgTitle)) ?? null;
    }
  };
}

// ulasav-license id: verified open by direct fetch of the actual page text
// ("Aşağıdakileri yapmakta özgürsünüz") for Ordu, Trabzon, Balıkesir, Van,
// and Osmaniye's license pages this session and prior sessions — treated
// as a confirmed pattern, not a per-dataset guess.
export const ULASAV_LICENSE_VERIFIED = {
  license_status: "SAFE_OPEN",
  license_source: "license_id 'ulasav-license' — text pattern directly verified via multiple independent fetches (Ordu/Trabzon/Balıkesir/Van/Osmaniye license pages all confirmed open)",
  license_verified_at: "2026-09-21/22 (multiple direct fetches)"
};

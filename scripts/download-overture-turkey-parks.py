#!/usr/bin/env python3
"""
Extracts Overture Maps Places within the "park" taxonomy family, bbox-limited
to Turkey, from the live public S3 dataset via DuckDB (httpfs + spatial).

This is the extraction step only — no taxonomy filtering, no province
verification, no reconciliation happens here (those are the Node.js
pipeline's job, reusing province-boundaries.mjs/district-boundaries.mjs,
matching the architecture already used for Konya/Ordu/Trabzon). This script
writes every row whose taxonomy.hierarchy is exactly
['sports_and_recreation', 'park', ...] — i.e. the real "park" branch and its
6 subcategories (park, national_park, water_park, playground, dog_park,
state_park) — verified empirically against the live 2026-08-19.0 release
(see docs/PARK_DATA_CHECKPOINT.md, "Milestone: Overture Maps Places — Turkey
Park Gap Analysis, Stage 1"). Categories outside this branch (amusement_park,
botanical_garden, nature_reserve, rv_park, etc.) sit in entirely different
hierarchy branches and are not extracted at all — never at risk of being
miscounted as a park by this structured filter.

Output: data/park-enrichment/.cache/overture/turkey-park-domain.json
(gitignored, atomic write via temp file + rename).
"""

import duckdb
import json
import time
import os
import sys

RELEASE = "2026-08-19.0"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "park-enrichment", ".cache", "overture")
OUT_PATH = os.path.join(OUT_DIR, "turkey-park-domain.json")
TMP_PATH = OUT_PATH + ".tmp"

# Coarse pre-filter only — the Node pipeline does the authoritative
# coordinate-based province containment check afterward, same principle as
# every other source in this pipeline (never trust a source field alone).
TURKEY_BBOX = {"min_lon": 25, "max_lon": 45, "min_lat": 35, "max_lat": 43}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ndjson_tmp = os.path.join(OUT_DIR, "turkey-park-domain.ndjson.tmp")

    con = duckdb.connect()
    con.execute("PRAGMA disable_progress_bar;")
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
    con.execute("SET s3_region='us-west-2';")
    con.execute("SET threads TO 8;")

    # Native DuckDB JSON export (COPY ... TO ... FORMAT JSON) serializes
    # nested STRUCT/LIST columns in C++ directly — avoids the slow
    # Arrow-table -> Python-list -> orjson round trip that timed out on the
    # first attempt (5 minutes, killed before even finishing the scan).
    query = f"""
        COPY (
          SELECT
            id,
            ST_X(geometry) AS longitude,
            ST_Y(geometry) AS latitude,
            taxonomy.primary AS taxonomy_primary,
            taxonomy.hierarchy AS taxonomy_hierarchy,
            taxonomy.alternates AS taxonomy_alternates,
            categories.primary AS categories_primary,
            categories.alternate AS categories_alternate,
            basic_category,
            names.primary AS name_primary,
            confidence,
            addresses,
            sources,
            version
          FROM read_parquet(
            's3://overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/*',
            hive_partitioning=1
          )
          WHERE bbox.xmin <= {TURKEY_BBOX['max_lon']} AND bbox.xmax >= {TURKEY_BBOX['min_lon']}
            AND bbox.ymin <= {TURKEY_BBOX['max_lat']} AND bbox.ymax >= {TURKEY_BBOX['min_lat']}
            AND len(taxonomy.hierarchy) >= 2
            AND taxonomy.hierarchy[1] = 'sports_and_recreation'
            AND taxonomy.hierarchy[2] = 'park'
        ) TO '{ndjson_tmp}' (FORMAT JSON)
    """

    print(f"Querying Overture release {RELEASE} (Turkey bbox + park hierarchy)...", file=sys.stderr)
    t0 = time.time()
    con.execute(query)
    elapsed = time.time() - t0
    print(f"Query + export done in {elapsed:.1f}s", file=sys.stderr)

    with open(ndjson_tmp, "r", encoding="utf-8") as f:
        cleaned = [json.loads(line) for line in f if line.strip()]
    os.remove(ndjson_tmp)

    print(f"Loaded {len(cleaned)} rows from export.", file=sys.stderr)

    manifest = {
        "release": RELEASE,
        "query_bbox": TURKEY_BBOX,
        "extraction_predicate": "taxonomy.hierarchy[1]='sports_and_recreation' AND taxonomy.hierarchy[2]='park'",
        "row_count": len(cleaned),
        "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "source_url_template": f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/*",
        "license_note": "Per-record license in sources[].license — CDLA Permissive 2.0 or Apache 2.0 depending on source, never ODbL.",
    }

    output = {"manifest": manifest, "features": cleaned}

    with open(TMP_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False)
    os.replace(TMP_PATH, OUT_PATH)

    print(f"Wrote {len(cleaned)} rows -> {OUT_PATH}", file=sys.stderr)

    taxonomy_counts = {}
    for r in cleaned:
        taxonomy_counts[r["taxonomy_primary"]] = taxonomy_counts.get(r["taxonomy_primary"], 0) + 1
    print("Taxonomy breakdown:", json.dumps(taxonomy_counts, indent=2), file=sys.stderr)


if __name__ == "__main__":
    main()

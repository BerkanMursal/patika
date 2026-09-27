import { pointInPolygonRings } from "./polygon-geometry.mjs";

// Generic exact-ish polygon relationship evidence, in a local metric plane.
// polys: array of polygons; polygon = array of rings [[lon,lat],...] (outer first).
// Returns { intersects, crossing, contains_a_in_b, contains_b_in_a, touches,
//           boundary_gap_m, overlap_fraction_a, overlap_fraction_b }.
// Min distance between two NON-intersecting polygons is always attained at a
// vertex of one and an edge of the other, so vertex<->edge distances are exact.

const KY = 110540;
function plane(polys, lat0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return polys.map(p => p.map(r => r.map(([lo, la]) => [lo * kx, la * KY])));
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}
function ccw(a, b, c) { return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]); }
function properCross(a, b, c, d) { const o1 = ccw(a, b, c), o2 = ccw(a, b, d), o3 = ccw(c, d, a), o4 = ccw(c, d, b); return o1 * o2 < 0 && o3 * o4 < 0; }
const edges = poly => poly.flatMap(ring => ring.slice(0, -1).map((v, i) => [v, ring[i + 1]]));
const inside = (pt, poly) => pointInPolygonRings(pt[0], pt[1], poly);

function bbox(polys) { let a = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of polys) for (const r of p) for (const v of r) { a = [Math.min(a[0], v[0]), Math.min(a[1], v[1]), Math.max(a[2], v[0]), Math.max(a[3], v[1])]; } return a; }
function sampleFraction(A, B) {           // share of A's area (grid sampled) that lies inside B
  const [x0, y0, x1, y1] = bbox(A); let inA = 0, inBoth = 0;
  const N = 30;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pt = [x0 + ((i + 0.5) / N) * (x1 - x0), y0 + ((j + 0.5) / N) * (y1 - y0)];
    if (A.some(p => inside(pt, p))) { inA++; if (B.some(p => inside(pt, p))) inBoth++; }
  }
  return inA ? inBoth / inA : 0;
}

export function polygonRelation(polysA, polysB) {
  const lat0 = polysA[0][0][0][1];
  const A = plane(polysA, lat0), B = plane(polysB, lat0);
  const ba = bbox(A), bb = bbox(B);
  const bboxGap = Math.hypot(Math.max(0, Math.max(ba[0], bb[0]) - Math.min(ba[2], bb[2])), Math.max(0, Math.max(ba[1], bb[1]) - Math.min(ba[3], bb[3])));
  let gap = Infinity, crossing = false, vertexInside = false;
  const eA = A.flatMap(edges), eB = B.flatMap(edges);
  for (const p of A) for (const v of p.flatMap(r => r)) { for (const q of B) { if (inside(v, q)) vertexInside = true; } for (const [c, d] of eB) gap = Math.min(gap, segDist(v, c, d)); }
  for (const q of B) for (const v of q.flatMap(r => r)) { for (const p of A) { if (inside(v, p)) vertexInside = true; } for (const [c, d] of eA) gap = Math.min(gap, segDist(v, c, d)); }
  if (bboxGap === 0) outer: for (const [a, b] of eA) for (const [c, d] of eB) if (properCross(a, b, c, d)) { crossing = true; break outer; }
  const fa = bboxGap === 0 ? sampleFraction(A, B) : 0, fb = bboxGap === 0 ? sampleFraction(B, A) : 0;
  const intersects = crossing || fa > 0 || fb > 0;        // interior overlap only (shared boundary is "touches")
  const touches = !intersects && gap <= 0.5;
  return {
    intersects, crossing, touches,
    boundary_gap_m: intersects ? 0 : Math.round(gap * 100) / 100,
    overlap_fraction_a: Math.round(fa * 1000) / 1000, overlap_fraction_b: Math.round(fb * 1000) / 1000,
    a_within_b: fa >= 0.98, b_within_a: fb >= 0.98
  };
}

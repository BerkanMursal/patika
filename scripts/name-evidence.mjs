import { clean, nameKey } from "./park-enrichment.mjs";

// Shared, conservative name-identity evidence used by the extended-radius
// review guard and the near-duplicate audit. Purely a REVIEW signal — never
// used to auto-match.

const WEAK_TOKENS = new Set([
  "park", "parki", "parklar", "parklari", "cocuk", "kent", "mahalle", "semt", "belediye", "belediyesi",
  "yesil", "alan", "alani", "oyun", "grubu", "isimsiz", "sokak", "sokagi", "meydan", "meydani",
  "aile", "dinlenme", "spor", "mesire", "bahce", "bahcesi"
]);

function tokens(name) {
  return clean(name)
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Distinctive part of a name once generic park-vocabulary is removed.
export function coreKey(name) {
  return tokens(name).filter(t => !WEAK_TOKENS.has(t)).join("");
}

// "Park", "Çocuk Parkı", "Kent Parkı", "Yeşil Alan", "İsimsiz park"... carry
// no identity by themselves.
export function isWeakName(name) {
  return coreKey(name) === "";
}

function similarity(x, y) {
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length);
}

export const STRONG_SIMILARITY = 0.88;

// Returns null when there is no strong identity evidence, otherwise
// { kind: "exact_normalized_name" | "same_core_name" | "high_similarity", similarity }.
export function strongNameEvidence(a, b) {
  if (isWeakName(a) || isWeakName(b)) return null;
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (ka === kb) return { kind: "exact_normalized_name", similarity: 1, key_a: ka, key_b: kb };
  if (coreKey(a) === coreKey(b)) return { kind: "same_core_name", similarity: similarity(ka, kb), key_a: ka, key_b: kb };
  const s = similarity(ka, kb);
  if (s >= STRONG_SIMILARITY) return { kind: "high_similarity", similarity: s, key_a: ka, key_b: kb };
  return null;
}

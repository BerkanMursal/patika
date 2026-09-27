import { clean, nameKey } from "./park-enrichment.mjs";
import { coreKey, isWeakName, WEAK_TOKENS } from "./name-evidence.mjs";
import { isPlaceholderName } from "./scoped-serial-identity.mjs";

// Explicit name-relationship evidence for the review-backlog resolver. Produces
// flags, never a score. Independent of (and stricter to reason about than) the
// engine's strongNameEvidence(): adds abbreviation normalisation and token-level
// containment/fuzzy matching, each reported as its own flag.

const ABBREV = { sht: "sehit" };

function tokens(name) {
  return clean(name)
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(t => ABBREV[t] ?? t);
}

export const coreTokens = name => tokens(name).filter(t => coreKey(t) !== "");

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length, 1);
}

function tokenMatch(a, b) {
  if (a === b) return true;
  const need = Math.min(a.length, b.length) >= 6 ? 0.75 : 0.85;
  return lev(a, b) >= need;
}

// greedy one-to-one fuzzy matching of token lists
function matchedCount(A, B) {
  const used = new Set();
  let m = 0;
  for (const a of A) {
    const j = B.findIndex((b, i) => !used.has(i) && tokenMatch(a, b));
    if (j !== -1) { used.add(j); m++; }
  }
  return m;
}

// A token that is a misspelling of a generic word ("yasil" for "yesil") is still generic.
const fuzzyWeak = t => WEAK_TOKENS.has(t) || [...WEAK_TOKENS].some(w => w.length >= 4 && t.length >= 4 && lev(t, w) >= 0.75);
export function nameFlags(name) {
  const core = coreTokens(name).filter(t => !fuzzyWeak(t));
  if (core.length === 0) return { generic: true, placeholder: isPlaceholderName(name) };
  return { generic: isWeakName(name), placeholder: isPlaceholderName(name) || (core.length > 0 && core.every(t => /^\d+$/.test(t))) };
}

// Relationship between a source name and a canonical name.
// opts.commonTokens: tokens too common in the local name population to count as
// distinctive (data-driven, supplied by the caller).
export function nameRelationship(a, b, opts = {}) {
  const out = { exact_normalized_name: false, distinctive_core_name_match: false, high_name_similarity: false, similarity: 0, kind: null, numeric_conflict: false, shares_distinctive_token: false };
  const fa = nameFlags(a), fb = nameFlags(b);
  if (fa.generic || fb.generic || fa.placeholder || fb.placeholder) return out; // generic names carry no name evidence
  const nums = n => tokens(n).filter(t => /^\d+$/.test(t)).sort().join(",");
  const differs = nums(a) !== nums(b);
  const strip = n => tokens(n).filter(t => !/^\d+$/.test(t));
  const eval_ = (A0, B0) => {
    const ka = A0.join(""), kb = B0.join("");
    const A = A0.filter(t => coreKey(t) !== ""), B = B0.filter(t => coreKey(t) !== "");
    const sim = Math.round(lev(ka, kb) * 1000) / 1000;
    if (ka === kb) return { kind: "exact_normalized_name", sim };
    if (A.length && B.length && A.join("") === B.join("")) return { kind: "core_equal", sim };
    const [S, L] = A.length <= B.length ? [A, B] : [B, A];
    if (S.length >= 2 && matchedCount(S, L) === S.length) return { kind: "core_contained", sim };
    const dice = A.length && B.length ? (2 * matchedCount(A, B)) / (A.length + B.length) : 0;
    if (sim >= 0.88 || (Math.min(A.length, B.length) >= 2 && dice >= 0.85)) return { kind: "high_similarity", sim, dice };
    return { kind: null, sim };
  };
  const r = differs ? eval_(strip(a), strip(b)) : eval_(tokens(a), tokens(b));
  out.similarity = r.sim;
  if (differs) { // same name modulo a differing number => a different park, flagged; otherwise unrelated names
    out.numeric_conflict = r.kind !== null;
    return out;
  }
  if (r.kind) { out.kind = r.kind; out.exact_normalized_name = r.kind === "exact_normalized_name"; out.distinctive_core_name_match = r.kind === "core_equal" || r.kind === "core_contained"; out.high_name_similarity = r.kind === "high_similarity"; if (r.dice !== undefined) out.token_dice = Math.round(r.dice * 1000) / 1000; return out; }
  const common = opts.commonTokens ?? new Set();
  const A = coreTokens(a).filter(t => t.length >= 4 && !common.has(t)), B = coreTokens(b).filter(t => t.length >= 4 && !common.has(t));
  out.shares_distinctive_token = A.some(t => B.some(u => tokenMatch(t, u)));
  return out;
}

export const hasNameEvidence = r => r.exact_normalized_name || r.distinctive_core_name_match || r.high_name_similarity;

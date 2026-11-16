// src/shared/payee.ts — frozen signatures (DESIGN §6.4), algorithm per §10.4.
import { distance } from "fastest-levenshtein";

/** Prefix aliases applied to the normalized string (token-boundary prefix match). Extend freely. */
export const PAYEE_ALIASES: readonly (readonly [prefixes: readonly string[], canonical: string])[] = [
  [["amzn", "amazon mktp", "amazon mktpl", "amazon com", "amazon digital", "prime video", "amazon prime"], "amazon"],
  [["wholefds", "whole foods"], "whole foods"],
  [["costco whse", "costco gas"], "costco"],
  [["wal mart", "walmart com", "wm supercenter"], "walmart"],
  [["target t"], "target"],
];

const PROCESSOR_PREFIXES = ["sq ", "tst ", "pp ", "paypal ", "sp ", "dd ", "pos ", "debit ", "purchase "] as const;
const DROP_TOKENS = new Set(["inc", "llc", "ltd", "co", "com", "www", "store", "us", "usa"]);
const US_STATES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la",
  "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
]);

function applyAliases(s: string): string {
  for (const [prefixes, canonical] of PAYEE_ALIASES) {
    for (const p of prefixes) {
      if (s === p || s.startsWith(`${p} `)) return canonical;
    }
  }
  return s;
}

/** Lower-case, strip diacritics/punctuation/processor prefixes/store numbers, apply ALIASES. */
export function normalizePayee(s: string): string {
  let out = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[*#/\\._,'"-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop processor prefixes (possibly stacked, e.g. "pos debit ...").
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PROCESSOR_PREFIXES) {
      if (out.startsWith(p)) {
        out = out.slice(p.length).trimStart();
        changed = true;
      }
    }
  }

  let tokens = out.split(" ").filter((t) => t.length > 0 && !/^\d{3,}$/.test(t) && !DROP_TOKENS.has(t));
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && last !== undefined && US_STATES.has(last)) tokens = tokens.slice(0, -1);

  return applyAliases(tokens.join(" "));
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(" ").filter((t) => t.length > 0));
}

function jaccard(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Best similarity in [0,1] between a user-typed payee and any of the non-null names. */
export function payeeSimilarity(intentPayee: string, names: (string | null)[]): number {
  const a = normalizePayee(intentPayee);
  if (a.length === 0) return 0;
  let best = 0;
  for (const n of names) {
    if (n === null) continue;
    const b = normalizePayee(n);
    if (b.length === 0) continue;
    if (a === b) return 1;
    if ((a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b))) best = Math.max(best, 0.9);
    const lev = 1 - distance(a, b) / Math.max(a.length, b.length);
    best = Math.max(best, lev, jaccard(a, b));
  }
  return best;
}

/** Best cached payee for a typed name, or null if none reaches `min` (default 0.9). */
export function bestPayeeMatch<P extends { id: string; name: string }>(name: string, payees: P[], min = 0.9): P | null {
  let best: P | null = null;
  let bestScore = -1;
  for (const p of payees) {
    const s = payeeSimilarity(name, [p.name]);
    if (s > bestScore || (s === bestScore && best !== null && p.name.length < best.name.length)) {
      best = p;
      bestScore = s;
    }
  }
  return best !== null && bestScore >= min ? best : null;
}

// domain/memo.ts — WP5 (DESIGN §10.8). PURE.
import { formatMilli } from "../../shared/money";
import type { CurrencyFormat } from "../../shared/schemas";
import { fmtDate } from "./labels";

/** YNAB's memo limit. */
export const MEMO_MAX = 500;
/** Prefix of a placeholder memo whose amount is approximate. */
export const APPROX_PREFIX = "≈ ";
/** Starts the human-readable note that says what the app did ("AI Boost: matched note from Nov 14"). */
export const ATTRIBUTION_PREFIX = "AI Boost:";
/** Longest "what was done" text after the prefix. */
export const ATTRIBUTION_MAX = 60;
const TAG_RE = /\[aib:([0-9A-Z]{6})\]/g;
const ELLIPSIS = "…";
/** Joins our item descriptions and the attribution. */
const ATTR_SEP = " · ";
/** An attribution at the end of the text before a tag. It never spans a " | " or another tag. */
const ATTR_TAIL_RE = /(?:\s·\s|\s)?AI Boost:[^|[\]]*$/;
/** Every attribution directly in front of a tag. */
const ATTR_BEFORE_TAG_RE = /(?:\s·\s|\s)?AI Boost:[^|[\]]*?\s*(?=\[aib:[0-9A-Z]{6}\])/g;

/** "[aib:XXXXXX]" */
export function memoTag(shortRef: string): string {
  return `[aib:${shortRef}]`;
}

export function hasTag(memo: string | null, shortRef: string): boolean {
  return memo !== null && memo.includes(memoTag(shortRef));
}

/** Every short ref tagged in a memo (in order, unique). */
export function tagsIn(memo: string | null): string[] {
  if (!memo) return [];
  return [...new Set([...memo.matchAll(TAG_RE)].map((m) => m[1] as string))];
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : max <= 0 ? "" : `${s.slice(0, Math.max(0, max - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`;

/** "AI Boost: <what>", compact. Brackets and "|" are removed, so it can never read as a tag or a memo part. */
export function attribution(what: string): string {
  const clean = what.replace(/[[\]|]/g, "").replace(/\s+/g, " ").trim();
  return `${ATTRIBUTION_PREFIX} ${truncate(clean, ATTRIBUTION_MAX)}`;
}

/** Short "what was done" texts for `attribution` / `mergeMemo` (§10.8). Dates are intent/plan dates ("Nov 14"). */
export const did = {
  placeholder: (amount: number, approximate: boolean, c: CurrencyFormat): string =>
    `placeholder for ${approximate ? "≈" : ""}${formatMilli(amount, c, "en-US")} note`,
  remaining: (amount: number, approximate: boolean, c: CurrencyFormat): string =>
    `placeholder for remaining ${approximate ? "≈" : ""}${formatMilli(amount, c, "en-US")}`,
  recorded: (noteDate: string): string => `recorded note from ${fmtDate(noteDate)}`,
  matched: (noteDate: string, amazon: boolean, categories: number): string => {
    const src = amazon ? "Amazon order" : "note";
    return categories > 1
      ? `split across ${categories} categories from ${src} of ${fmtDate(noteDate)}`
      : `matched ${src} from ${fmtDate(noteDate)}`;
  },
  needsSplit: (noteDate: string, amazon: boolean): string =>
    `linked to ${amazon ? "Amazon order" : "note"} from ${fmtDate(noteDate)}, split it in YNAB`,
  kept: (): string => "kept as final",
  edited: (today: string, voice: boolean): string => `${voice ? "edited by voice/text" : "edited in the app"} (${fmtDate(today)})`,
};

/** Puts `attr` directly before `tag`, replacing our earlier attribution there. User text is never touched.
 *  If the result would exceed 500 chars, the earlier attribution is only removed (never left stale). */
function withAttribution(memo: string, tag: string, attr: string): string {
  const i = memo.indexOf(tag);
  const head = memo.slice(0, i).replace(ATTR_TAIL_RE, "").trimEnd();
  const tail = memo.slice(i);
  const joiner = head === "" ? "" : head.endsWith("|") ? " " : ATTR_SEP;
  const out = `${head}${joiner}${attr} ${tail}`;
  return out.length <= MEMO_MAX ? out : `${head}${head ? " " : ""}${tail}`;
}

/** The memo without our attributions (old-format memos come back unchanged). For "is this still our memo?". */
export function stripAttribution(memo: string | null): string {
  return (memo ?? "").replace(ATTR_BEFORE_TAG_RE, " ").replace(/^ +/, "").trim();
}

/** Appends "<addition> · AI Boost: <did> <tag>" to an existing memo with " | ". Never exceeds 500 chars; the
 *  addition is truncated first, then the attribution is dropped; the tag is never cut. User text is only
 *  shortened in the degenerate case where it alone leaves no room for the tag (YNAB would reject a longer memo).
 *  Idempotent: a memo that already carries the tag is returned trimmed, with our attribution in front of the
 *  tag set to `didWhat` (replacing an earlier one, or added to an old-format memo). */
export function mergeMemo(existing: string | null, addition: string | null, tag: string, didWhat: string | null = null): string {
  const base = existing?.trim() ?? "";
  const attr = didWhat ? attribution(didWhat) : null;
  if (base.includes(tag)) return attr ? withAttribution(base, tag, attr) : base;
  const add = addition?.trim() ?? "";
  const sep = base ? " | " : "";
  for (const a of attr ? [attr, null] : [null]) {
    const tail = a ? `${a} ${tag}` : tag;
    const join = a ? ATTR_SEP : " ";
    const room = MEMO_MAX - base.length - sep.length - tail.length;
    if (room < 0) continue;
    // room for the tail; fit as much of the addition as possible
    const body = add && room > join.length ? truncate(add, room - join.length) : "";
    const keep = body && body !== ELLIPSIS ? `${body}${join}` : "";
    return `${base}${sep}${keep}${tail}`;
  }
  // Degenerate: the user's memo is so long that even the tag does not fit.
  return `${truncate(base, MEMO_MAX - 3 - tag.length)} | ${tag}`;
}

/** Strips the "≈ " placeholder prefix (used by "Keep as final"); keeps the tag and everything else. */
export function stripApprox(memo: string | null): string | null {
  if (memo === null) return null;
  return memo.startsWith(APPROX_PREFIX) ? memo.slice(APPROX_PREFIX.length) : memo.replace(/^≈\s*/, "");
}

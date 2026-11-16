// domain/memo.ts — WP5 (DESIGN §10.8). PURE.

/** YNAB's memo limit. */
export const MEMO_MAX = 500;
/** Prefix of a placeholder memo whose amount is approximate. */
export const APPROX_PREFIX = "≈ ";
const TAG_RE = /\[aib:([0-9A-Z]{6})\]/g;
const ELLIPSIS = "…";

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

/** Appends "<addition> <tag>" to an existing memo with " | ". Never exceeds 500 chars; the addition is
 *  truncated first. User text is only shortened in the degenerate case where it alone leaves no room for the tag
 *  (YNAB would reject a longer memo). Idempotent: a memo that already carries the tag is returned trimmed. */
export function mergeMemo(existing: string | null, addition: string | null, tag: string): string {
  const base = existing?.trim() ?? "";
  if (base.includes(tag)) return base;
  const add = addition?.trim() ?? "";
  const sep = base ? " | " : "";
  const room = MEMO_MAX - base.length - sep.length - tag.length;
  if (room >= 0) {
    // room for the tag; fit as much of the addition as possible ("<addition> <tag>")
    const extra = add && room > 1 ? `${truncate(add, room - 1)} ${tag}` : tag;
    const cleaned = extra.startsWith(" ") ? extra.trimStart() : extra;
    return `${base}${sep}${cleaned}`;
  }
  // Degenerate: the user's memo is so long that even the tag does not fit.
  return `${truncate(base, MEMO_MAX - 3 - tag.length)} | ${tag}`;
}

/** Strips the "≈ " placeholder prefix (used by "Keep as final"); keeps the tag and everything else. */
export function stripApprox(memo: string | null): string | null {
  if (memo === null) return null;
  return memo.startsWith(APPROX_PREFIX) ? memo.slice(APPROX_PREFIX.length) : memo.replace(/^≈\s*/, "");
}

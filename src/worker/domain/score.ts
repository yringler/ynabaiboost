// domain/score.ts — WP5 (DESIGN §10.5, §10.9 loose candidates). PURE.
import { diffDays } from "../../shared/dates";
import { payeeSimilarity } from "../../shared/payee";
import { dateScore, dateWindow, inWindow } from "./dates";
import { fits } from "./subsets";
import type { DIntent, DLine, DTxn, ReconcileInput } from "./types";

export const AUTO = 0.8;
export const MARGIN = 0.1;
export const REVIEW_MIN = 0.6;
/** Cap for candidates that must never auto-apply (payee mismatch, already-approved import). */
export const REVIEW_CAP = 0.79;
/** Loose (manual link / possible intent) thresholds, §10.9. */
export const LOOSE_PAYEE_MIN = 0.5;
export const LOOSE_AMOUNT_FACTOR = 3;
export const POSSIBLE_MIN = 0.5;

export const openLines = (i: { lines: DLine[] }): DLine[] => i.lines.filter((l) => l.status === "open");
export const txnNames = (t: DTxn): (string | null)[] => [t.payeeName, t.importPayeeNameOriginal, t.importPayeeName];
export const signMatches = (t: DTxn, i: Pick<DIntent, "direction">): boolean =>
  i.direction === "outflow" ? t.amount < 0 : t.amount > 0;

/** True when an import was already approved with a real category in YNAB (§10.5): review-only. */
export function isApprovedImport(t: DTxn, uncategorizedIds: Set<string>): boolean {
  return t.approved && t.categoryId !== null && !uncategorizedIds.has(t.categoryId);
}

/** Single-line Amazon intents use `fits` (tax allowed) instead of the tolerance check. */
export const isAmazonSingle = (i: DIntent): boolean => i.merchantKind === "amazon" && openLines(i).length < 2;

/** The parts of the §10.5 candidate filter that do not depend on the amount. */
export function baseCandidate(i: DIntent, t: DTxn, input: Pick<ReconcileInput, "excluded" | "settings">): boolean {
  if (t.deleted || t.transferAccountId !== null) return false;
  if (t.importId === null) return false;
  if (input.excluded.has(t.id) || t.id === i.placeholderTxnId) return false;
  if (!signMatches(t, i)) return false;
  if (t.isSplit) return false;
  if (i.accountExplicit && t.accountId !== i.accountId) return false;
  const delta = diffDays(t.date, i.date);
  return inWindow(delta, dateWindow(i.merchantKind, input.settings.amazonWindowDays));
}

export interface ScoreDetail { score: number; diff: number; payeeSim: number; dateScore: number; reviewOnly: boolean }

/** Raw §10.5 score components without any threshold (used by the strict and the loose paths). */
export function rawScore(i: DIntent, t: DTxn, amazonWindowDays: number, diffOverride?: number): ScoreDetail {
  const diff = diffOverride ?? Math.abs(Math.abs(t.amount) - i.total);
  const amountScore = diff <= 10 ? 1 : Math.max(0, 1 - 0.5 * (diff / Math.max(1, i.tolerance)));
  const w = dateWindow(i.merchantKind, amazonWindowDays);
  const ds = dateScore(diffDays(t.date, i.date), w.after);
  const payeeSim = payeeSimilarity(i.payee, txnNames(t));
  const accountBonus = i.accountId !== null && t.accountId === i.accountId ? 0.05 : 0;
  const score = 0.45 * amountScore + 0.2 * ds + 0.35 * payeeSim + accountBonus;
  return { score, diff, payeeSim, dateScore: ds, reviewOnly: false };
}

/** §10.5: full candidate filter + score (with the payee and approved-import caps), or null when the txn is
 *  not a candidate. The REVIEW_MIN threshold is applied by the planner. */
export function scoreDetail(i: DIntent, t: DTxn, input: ReconcileInput): ScoreDetail | null {
  if (!baseCandidate(i, t, input)) return null;
  const abs = Math.abs(t.amount);
  if (isAmazonSingle(i)) {
    if (!fits(abs, openLines(i).length ? openLines(i) : i.lines, input.settings.maxTaxRate)) return null;
  } else if (Math.abs(abs - i.total) > i.tolerance) {
    return null;
  }
  // A single-line Amazon charge may carry tax: its amount is scored by its distance to [total, total·(1+maxTax)].
  const d = rawScore(i, t, input.settings.amazonWindowDays,
    isAmazonSingle(i) ? taxedDiff(abs, i.total, input.settings.maxTaxRate) : undefined);
  if (d.payeeSim < 0.4) d.score = Math.min(d.score, REVIEW_CAP);
  if (isApprovedImport(t, input.uncategorizedIds)) {
    d.score = Math.min(d.score, REVIEW_CAP);
    d.reviewOnly = true;
  }
  return d;
}

/** Distance from `abs` to the taxed range [total, total·(1+maxTaxRate)]. */
export function taxedDiff(abs: number, total: number, maxTaxRate: number): number {
  const hi = Math.round(total * (1 + maxTaxRate));
  return abs < total ? total - abs : abs > hi ? abs - hi : 0;
}

/** §10.5 score, or null when the txn fails the candidate filter. */
export function scoreCandidate(i: DIntent, t: DTxn, input: ReconcileInput): number | null {
  return scoreDetail(i, t, input)?.score ?? null;
}

/** §10.9 loose filter for manual linking and `possibleIntentFor`: an import, not split/deleted/transfer,
 *  right sign, not excluded, and payeeSim ≥ 0.5 or the amount within 3 × tolerance. Returns the §10.5 score
 *  computed without thresholds, or null. (The 45-day age limit is applied by the caller.) */
export function looseScore(i: DIntent, t: DTxn, excluded: Set<string>, amazonWindowDays: number): number | null {
  if (t.deleted || t.transferAccountId !== null || t.importId === null || t.isSplit) return null;
  if (excluded.has(t.id) || t.id === i.placeholderTxnId) return null;
  if (!signMatches(t, i)) return null;
  const d = rawScore(i, t, amazonWindowDays);
  if (d.payeeSim < LOOSE_PAYEE_MIN && d.diff > LOOSE_AMOUNT_FACTOR * i.tolerance) return null;
  return d.score;
}

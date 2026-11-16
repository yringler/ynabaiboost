// domain/subsets.ts — WP5 (DESIGN §10.6). PURE. Amazon multi-charge fitting and option enumeration.
import { diffDays } from "../../shared/dates";
import type { ReviewOption } from "../../shared/schemas";
import { allocate } from "./allocate";
import { dateScore, dateWindow } from "./dates";
import type { DIntent, DLine, DTxn, ReconcileInput } from "./types";

export const MAX_LINES = 12;
export const MAX_CHARGES = 6;
export const MAX_SOLUTIONS = 5000;
const EXPECTED_TAX = 0.07;

export type PlannedOption = Omit<ReviewOption, "label">;

/** Lowest and highest charge a subset of lines can explain (tax allowed up to maxTaxRate). */
export function fitRange(lines: Pick<DLine, "amount" | "tolerance">[], maxTaxRate: number): { lo: number; hi: number } {
  const base = lines.reduce((s, l) => s + l.amount, 0);
  const tol = Math.min(lines.reduce((s, l) => s + l.tolerance, 0), Math.round(0.25 * base)) + 500;
  return { lo: base - tol, hi: Math.round(base * (1 + maxTaxRate)) + tol };
}

export function fits(charge: number, lines: Pick<DLine, "amount" | "tolerance">[], maxTaxRate: number): boolean {
  if (lines.length === 0) return false;
  const { lo, hi } = fitRange(lines, maxTaxRate);
  return lo <= charge && charge <= hi;
}

/** Non-empty subsets of `lines` (bitmask order), at most `limit`. */
export function* subsetsOf<T>(lines: T[], limit = MAX_SOLUTIONS * 4): Generator<T[]> {
  const n = Math.min(lines.length, MAX_LINES);
  const total = 2 ** n;
  let produced = 0;
  for (let mask = 1; mask < total && produced < limit; mask++, produced++) {
    const s: T[] = [];
    for (let b = 0; b < n; b++) if (mask & (1 << b)) s.push(lines[b] as T);
    yield s;
  }
}

/** Does any non-empty subset of `lines` fit `charge`? Above MAX_LINES the whole range is used (conservative). */
export function anySubsetFits(charge: number, lines: DLine[], maxTaxRate: number): boolean {
  if (lines.length === 0) return false;
  if (lines.length > MAX_LINES) {
    const minLo = Math.min(...lines.map((l) => fitRange([l], maxTaxRate).lo));
    return minLo <= charge && charge <= fitRange(lines, maxTaxRate).hi;
  }
  for (const s of subsetsOf(lines)) if (fits(charge, s, maxTaxRate)) return true;
  return false;
}

/** §10.6 option score: complete coverage first, then date closeness and a plausible tax rate. */
export function optionScore(i: DIntent, charge: DTxn, subset: DLine[], allOpen: number, amazonWindowDays: number): number {
  const base = subset.reduce((s, l) => s + l.amount, 0);
  const impliedTax = base > 0 ? Math.abs(charge.amount) / base - 1 : 0;
  const ds = dateScore(diffDays(charge.date, i.date), dateWindow(i.merchantKind, amazonWindowDays).after);
  return (subset.length === allOpen ? 1 : 0.5) + 0.3 * ds - 0.1 * Math.abs(impliedTax - EXPECTED_TAX);
}

/** Every (charge, subset of open lines) pair that fits, best first (stops at MAX_SOLUTIONS).
 *  Option ids are left empty; the planner numbers the options it keeps. */
export function enumerateAssignments(i: DIntent, charges: DTxn[], input: Pick<ReconcileInput, "settings" | "decimalDigits">): PlannedOption[] {
  const open = i.lines.filter((l) => l.status === "open").slice(0, MAX_LINES);
  const out: (PlannedOption & { _date: number })[] = [];
  outer: for (const c of charges) {
    const abs = Math.abs(c.amount);
    for (const s of subsetsOf(open)) {
      if (!fits(abs, s, input.settings.maxTaxRate)) continue;
      out.push({
        id: "", intentId: i.id, transactionId: c.id, lineIds: s.map((l) => l.id),
        allocation: allocate(abs, s, i.direction, input.decimalDigits),
        score: optionScore(i, c, s, open.length, input.settings.amazonWindowDays),
        _date: Math.abs(diffDays(c.date, i.date)),
      });
      if (out.length >= MAX_SOLUTIONS) break outer;
    }
  }
  out.sort((a, b) => b.score - a.score || a._date - b._date || a.transactionId.localeCompare(b.transactionId) || a.lineIds.length - b.lineIds.length);
  return out.map(({ _date: _, ...o }) => o);
}

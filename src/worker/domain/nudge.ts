// domain/nudge.ts — WP5 (DESIGN D13, §10.7). PURE.
import { minorUnit } from "../../shared/money";

/** D13: an approximate placeholder amount is lowered by one minor unit (200.00 → 199.99) on every write, so
 *  YNAB cannot exact-match an unrelated round-number import. Amounts of one minor unit or less are left alone. */
export function nudged(amount: number, approximate: boolean, decimals: number): number {
  const u = minorUnit(decimals);
  return approximate && amount > u ? amount - u : amount;
}

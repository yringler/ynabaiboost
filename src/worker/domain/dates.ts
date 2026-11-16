// domain/dates.ts — WP5 (DESIGN §10.3). PURE.
import type { MerchantKind } from "../../shared/schemas";

export interface DateWindow { before: number; after: number }

/** Days before/after the intent date in which a charge may post. */
export function dateWindow(kind: MerchantKind, amazonWindowDays: number): DateWindow {
  switch (kind) {
    case "in_person": return { before: 2, after: 7 };
    case "online": return { before: 2, after: 14 };
    case "amazon": return { before: 2, after: amazonWindowDays };
    case "other": return { before: 2, after: 10 };
  }
}

/** True when delta = diffDays(txn.date, intent.date) is inside the window. */
export function inWindow(delta: number, w: DateWindow): boolean {
  return delta >= -w.before && delta <= w.after;
}

/** delta = diffDays(txn.date, intent.date); 0 outside the window (the candidate is dropped).
 *  1.0 for 0..2 days, linear down to 0.3 at `after`, 0.7 for −2..−1. */
export function dateScore(delta: number, after: number): number {
  if (delta < -2 || delta > after) return 0;
  if (delta < 0) return 0.7;
  if (delta <= 2) return 1;
  if (after <= 2) return 1;
  return 1 - (0.7 * (delta - 2)) / (after - 2);
}

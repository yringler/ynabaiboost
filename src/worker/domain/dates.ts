// domain/dates.ts — WP5 (DESIGN §10.3). PURE. Stub created by WP1; signatures are WP5-internal (not frozen).
import type { MerchantKind } from "../../shared/schemas";

export function dateWindow(_kind: MerchantKind, _amazonWindowDays: number): { before: number; after: number } {
  throw new Error("not implemented: dateWindow");
}
/** delta = diffDays(txn.date, intent.date); 0 outside the window. */
export function dateScore(_delta: number, _after: number): number {
  throw new Error("not implemented: dateScore");
}

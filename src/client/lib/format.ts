// lib/format.ts — WP6 (DESIGN §11.1): formatMilli wrapper using me.plan.currency; parseMoneyInput. Stub created by WP1.
import type { Milliunits } from "../../shared/money";
import type { CurrencyFormat } from "../../shared/schemas";

export function formatMoney(_m: Milliunits, _currency: CurrencyFormat | null): string {
  throw new Error("not implemented: formatMoney");
}
/** Parses user input like "12.50" or "≈200" into positive milliunits, or null when invalid. */
export function parseMoneyInput(_s: string, _decimalDigits: number): Milliunits | null {
  throw new Error("not implemented: parseMoneyInput");
}

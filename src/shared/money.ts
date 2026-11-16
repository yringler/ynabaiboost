// src/shared/money.ts
export type Milliunits = number; // integer
export type Direction = "outflow" | "inflow";

export const toMilli = (units: number): Milliunits => Math.round(units * 1000);
export const fromMilli = (m: Milliunits): number => m / 1000;
/** Smallest currency step in milliunits: 10 for 2-decimal currencies, 1000 for 0-decimal. */
export const minorUnit = (decimalDigits: number): Milliunits => 10 ** Math.max(0, 3 - decimalDigits);
export const roundToMinor = (m: Milliunits, decimalDigits: number): Milliunits => {
  const u = minorUnit(decimalDigits);
  return Math.round(m / u) * u;
};
/** Our models store positive amounts + direction; YNAB stores signed. */
export const toYnabAmount = (amount: Milliunits, direction: Direction): Milliunits =>
  direction === "outflow" ? -amount : amount;
export function formatMilli(
  m: Milliunits,
  currency: { isoCode: string; decimalDigits: number },
  locale?: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency", currency: currency.isoCode,
    minimumFractionDigits: currency.decimalDigits, maximumFractionDigits: currency.decimalDigits,
  }).format(m / 1000);
}

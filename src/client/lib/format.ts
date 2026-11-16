// lib/format.ts — WP6 (DESIGN §11.1): formatMilli wrapper using me.plan.currency; parseMoneyInput.
import { formatMilli, type Milliunits } from "../../shared/money";
import type { CurrencyFormat } from "../../shared/schemas";

/** Used before the plan (and its currency) is known. */
export const FALLBACK_CURRENCY: CurrencyFormat = { isoCode: "USD", decimalDigits: 2 };

export function formatMoney(m: Milliunits, currency: CurrencyFormat | null): string {
  const c = currency ?? FALLBACK_CURRENCY;
  try {
    return formatMilli(m, c);
  } catch {
    // Unknown ISO code in this browser's Intl data: fall back to a plain number with the code.
    return `${(m / 1000).toFixed(Math.max(0, Math.min(3, c.decimalDigits)))} ${c.isoCode}`;
  }
}

/** "≈ $200.00" for approximate amounts. */
export function formatApprox(m: Milliunits, approximate: boolean, currency: CurrencyFormat | null): string {
  return `${approximate ? "≈ " : ""}${formatMoney(m, currency)}`;
}

const APPROX_PREFIX = /^\s*(?:≈|~|about\s+|approx\.?\s+|ca\.?\s+)/i;

/** True when the user typed an approximate marker ("≈200", "~200", "about 200"). */
export function hasApproxMarker(s: string): boolean {
  return APPROX_PREFIX.test(s);
}

/**
 * Parses user input like "12.50", "≈200", "$1,234.5" or "12,50" into positive milliunits, or null when invalid.
 * - Strips approximate markers, currency symbols/codes and spaces.
 * - Decimal separator: the last of "." / "," when both appear; a lone "." is always decimal; a lone "," is
 *   decimal unless followed by exactly 3 digits ("1,000" is a thousands separator).
 * - More fraction digits than the currency allows, zero, negatives or junk → null.
 * Integer arithmetic only, so "0.1 + 0.2" style float errors cannot leak into milliunits.
 */
export function parseMoneyInput(s: string, decimalDigits: number): Milliunits | null {
  let t = s.replace(APPROX_PREFIX, "").trim();
  if (t.startsWith("-") || t.startsWith("−")) return null;
  t = t.replace(/[\s  ']/g, "").replace(/^[^\d.,]+/, "").replace(/[^\d.,]+$/, "");
  if (!/^[\d.,]+$/.test(t)) return null;

  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let intPart: string;
  let frac = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const decIdx = Math.max(lastDot, lastComma);
    const thousandsSep = decIdx === lastDot ? "," : ".";
    intPart = t.slice(0, decIdx);
    frac = t.slice(decIdx + 1);
    if (intPart.includes(t[decIdx] ?? "")) return null;
    if (!isGroupedInt(intPart, thousandsSep)) return null;
    intPart = intPart.split(thousandsSep).join("");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = t.split(sep);
    if (parts.length === 2 && parts[1] !== undefined && (sep === "." || parts[1].length !== 3 || decimalDigits === 3)) {
      intPart = parts[0] ?? "";
      frac = parts[1];
    } else if (isGroupedInt(t, sep)) {
      intPart = parts.join("");
    } else {
      return null;
    }
  } else {
    intPart = t;
  }
  if (intPart === "") intPart = "0";
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(frac)) return null;
  if (frac.length > Math.max(0, decimalDigits)) return null;
  if (intPart.length > 12) return null; // beyond any sane amount; keeps us inside safe integers

  const milli = Number(intPart) * 1000 + Number((frac + "000").slice(0, 3));
  return milli > 0 ? milli : null;
}

function isGroupedInt(s: string, sep: string): boolean {
  if (!s.includes(sep)) return /^\d+$/.test(s);
  const groups = s.split(sep);
  const [first, ...rest] = groups;
  return first !== undefined && /^[1-9]\d{0,2}$/.test(first) && rest.every((g) => /^\d{3}$/.test(g));
}

/** Milliunits → editable text ("12.5" → "12.50"), no currency symbol, no grouping. */
export function milliToInput(m: Milliunits | null, decimalDigits: number): string {
  if (m === null) return "";
  const d = Math.max(0, Math.min(3, decimalDigits));
  return (m / 1000).toFixed(d);
}

/** "Nov 14" (or "Nov 14, 2025" for another year). Dates are calendar dates, so format in UTC. */
export function formatDate(iso: string, now: Date = new Date()): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getUTCFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric", timeZone: "UTC", ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" for an epoch-ms timestamp. */
export function formatRelative(at: number, now: number = Date.now()): string {
  const sec = Math.round((now - at) / 1000);
  if (sec < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
  const min = Math.round(sec / 60);
  if (min < 60) return rtf.format(-min, "minute");
  const h = Math.round(min / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const days = Math.round(h / 24);
  return rtf.format(-days, "day");
}

export function formatTimestamp(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

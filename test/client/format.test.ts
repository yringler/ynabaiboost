import { describe, expect, it } from "vitest";
import { formatMoney, formatRelative, hasApproxMarker, milliToInput, parseMoneyInput } from "../../src/client/lib/format";

describe("parseMoneyInput (2 decimals)", () => {
  const p = (s: string) => parseMoneyInput(s, 2);
  it.each([
    ["12.50", 12_500], ["12,50", 12_500], ["200", 200_000], ["≈200", 200_000], ["~ 200", 200_000], ["about 200", 200_000],
    ["$1,234.56", 1_234_560], ["1.234,56 €", 1_234_560], ["1,000", 1_000_000], ["1 000", 1_000_000], [".5", 500],
    ["12.", 12_000], ["0.01", 10], ["USD 9.99", 9_990], ["0.1", 100],
  ])("%s → %d", (input, expected) => {
    expect(p(input)).toBe(expected);
  });
  it.each(["", "abc", "-5", "−5", "0", "0.00", "12.345", "1,2,3", "1.2.3", "12..5", "0.001", "1e5"])("%s → null", (input) => {
    expect(p(input)).toBeNull();
  });
});

describe("parseMoneyInput (0 and 3 decimals)", () => {
  it("rejects fractions for zero-decimal currencies", () => {
    expect(parseMoneyInput("1500", 0)).toBe(1_500_000);
    expect(parseMoneyInput("15.5", 0)).toBeNull();
  });
  it("accepts 3 fraction digits for 3-decimal currencies", () => {
    expect(parseMoneyInput("1.234", 3)).toBe(1_234);
  });
});

describe("format helpers", () => {
  it("formatMoney uses the plan currency and falls back to USD", () => {
    expect(formatMoney(12_340, { isoCode: "USD", decimalDigits: 2 })).toMatch(/12\.34/);
    expect(formatMoney(12_340, null)).toMatch(/12\.34/);
    expect(formatMoney(1_500_000, { isoCode: "JPY", decimalDigits: 0 })).toMatch(/1,500/);
  });
  it("milliToInput round-trips with parseMoneyInput", () => {
    expect(milliToInput(173_500, 2)).toBe("173.50");
    expect(parseMoneyInput(milliToInput(173_500, 2), 2)).toBe(173_500);
    expect(milliToInput(null, 2)).toBe("");
  });
  it("hasApproxMarker", () => {
    expect(hasApproxMarker("≈ 20")).toBe(true);
    expect(hasApproxMarker("20")).toBe(false);
  });
  it("formatRelative", () => {
    const now = 1_000_000_000_000;
    expect(formatRelative(now - 10_000, now)).toBe("just now");
    expect(formatRelative(now - 5 * 60_000, now)).toMatch(/5 min/);
  });
});

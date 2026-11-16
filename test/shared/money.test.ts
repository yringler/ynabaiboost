import { describe, expect, it } from "vitest";
import { formatMilli, fromMilli, minorUnit, roundToMinor, toMilli, toYnabAmount } from "../../src/shared/money";

describe("money", () => {
  it("converts units ↔ milliunits", () => {
    expect(toMilli(12.34)).toBe(12340);
    expect(toMilli(0.1 + 0.2)).toBe(300);
    expect(fromMilli(199990)).toBe(199.99);
  });
  it("minorUnit by decimal digits", () => {
    expect(minorUnit(2)).toBe(10);
    expect(minorUnit(0)).toBe(1000);
    expect(minorUnit(3)).toBe(1);
    expect(minorUnit(5)).toBe(1);
  });
  it("roundToMinor", () => {
    expect(roundToMinor(12345, 2)).toBe(12350);
    expect(roundToMinor(12344, 2)).toBe(12340);
    expect(roundToMinor(1499, 0)).toBe(1000);
  });
  it("toYnabAmount signs outflows negative", () => {
    expect(toYnabAmount(5000, "outflow")).toBe(-5000);
    expect(toYnabAmount(5000, "inflow")).toBe(5000);
  });
  it("formatMilli", () => {
    expect(formatMilli(-212470, { isoCode: "USD", decimalDigits: 2 }, "en-US")).toBe("-$212.47");
    expect(formatMilli(1500000, { isoCode: "JPY", decimalDigits: 0 }, "en-US")).toBe("¥1,500");
  });
});

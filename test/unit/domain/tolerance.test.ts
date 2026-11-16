import { describe, expect, it } from "vitest";
import { computeTolerance, roundnessUnit } from "../../../src/worker/domain/tolerance";

describe("roundnessUnit (§10.2)", () => {
  it.each([
    [200000, 100000], [150000, 50000], [175000, 25000], [130000, 10000], [85000, 5000], [47000, 1000], [3000, 1000],
    [47230, 0], [173500, 0], [1, 0], [1000, 1000], [25000, 25000], [10000, 10000], [5000, 5000],
  ])("roundnessUnit(%i) = %i", (a, u) => expect(roundnessUnit(a)).toBe(u));
});

describe("computeTolerance (§10.2 table)", () => {
  it("~$200 → 50 (173.50 fits)", () => {
    expect(computeTolerance(200000, true)).toBe(50000);
    expect(Math.abs(173500 - 200000)).toBeLessThanOrEqual(computeTolerance(200000, true));
  });
  it("$175 → 12.50 (173.50 fits)", () => {
    expect(computeTolerance(175000, true)).toBe(12500);
    expect(Math.abs(173500 - 175000)).toBeLessThanOrEqual(12500);
  });
  it("~$85 → 4.25 (91.20 does not fit as a single charge)", () => {
    expect(computeTolerance(85000, true)).toBe(4250);
    expect(Math.abs(91200 - 85000)).toBeGreaterThan(4250);
  });
  it("$47.23 exact → 0.50", () => expect(computeTolerance(47230, false)).toBe(500));
  it("exact amounts: 1% (min 0.50) with cents, 2% (min 1.00) when round", () => {
    expect(computeTolerance(123450, false)).toBe(1235);
    expect(computeTolerance(200000, false)).toBe(4000);
    expect(computeTolerance(20000, false)).toBe(1000);
  });
  it("approximate tolerance is at least $1 but never above 35% of the amount", () => {
    expect(computeTolerance(6000, true)).toBe(1000);
    expect(computeTolerance(2000, true)).toBe(700); // 35% cap beats the $1 floor
    expect(computeTolerance(1000000, true)).toBe(50000); // ~$1000: max(u/2 = 50, 5% = 50, 1)
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { minorUnit } from "../../../src/shared/money";
import { allocate } from "../../../src/worker/domain/allocate";
import { nudged } from "../../../src/worker/domain/nudge";

const L = (categoryId: string, amount: number, description = categoryId) => ({ categoryId, amount, description });

describe("allocate (§10.8)", () => {
  it("single category takes the whole charge, signed by direction", () => {
    expect(allocate(173500, [L("g", 200000, "groceries")], "outflow", 2)).toEqual([{ categoryId: "g", amount: -173500, memo: "groceries" }]);
    expect(allocate(5000, [L("g", 6000)], "inflow", 2)).toEqual([{ categoryId: "g", amount: 5000, memo: "g" }]);
  });
  it("groups lines by category and joins descriptions", () => {
    const a = allocate(60000, [L("a", 10000, "pen"), L("b", 20000, "ink"), L("a", 30000, "paper")], "outflow", 2);
    expect(a).toEqual([{ categoryId: "a", amount: -40000, memo: "pen, paper" }, { categoryId: "b", amount: -20000, memo: "ink" }]);
  });
  it("largest remainder: 10.00 over three equal lines", () => {
    const a = allocate(10000, [L("a", 1), L("b", 1), L("c", 1)], "outflow", 2);
    expect(a.map((x) => x.amount)).toEqual([-3340, -3330, -3330]);
  });
  it("ties go to the larger weight, then categoryId", () => {
    expect(allocate(30, [L("b", 1), L("a", 1)], "inflow", 2).map((x) => x.amount)).toEqual([10, 20]);
  });
  it("zero-decimal currencies allocate whole units", () => {
    const a = allocate(1000000, [L("a", 1), L("b", 2)], "outflow", 0);
    for (const x of a) expect(Math.abs(x.amount) % 1000).toBe(0);
    expect(a.reduce((s, x) => s + x.amount, 0)).toBe(-1000000);
  });
  it("memo is at most 100 chars", () => {
    const a = allocate(1000, [L("a", 1, "x".repeat(80)), L("a", 1, "y".repeat(80))], "outflow", 2);
    expect(a[0]?.memo?.length).toBeLessThanOrEqual(100);
  });
  it("zero total weight still allocates exactly", () => {
    expect(allocate(1230, [L("a", 0), L("b", 0)], "outflow", 2).reduce((s, x) => s + x.amount, 0)).toBe(-1230);
  });
  it("odd sub-unit milliunits are kept exactly", () => {
    expect(allocate(1235, [L("a", 1), L("b", 1)], "outflow", 2).reduce((s, x) => s + x.amount, 0)).toBe(-1235);
  });
  it("no lines → empty", () => expect(allocate(1000, [], "outflow", 2)).toEqual([]));

  const linesArb = fc.array(fc.record({ categoryId: fc.constantFrom("a", "b", "c", "d", "e"), amount: fc.integer({ min: 1, max: 5_000_000 }), description: fc.string({ maxLength: 10 }) }), { minLength: 1, maxLength: 12 });
  const decimalsArb = fc.constantFrom(0, 2, 3);

  it("property: the sum is exact and every amount is a multiple of the minor unit", () => {
    fc.assert(fc.property(linesArb, decimalsArb, fc.integer({ min: 0, max: 100_000_000 }), fc.boolean(), (lines, dec, k, out) => {
      const unit = minorUnit(dec);
      const charge = k * unit;
      const a = allocate(charge, lines, out ? "outflow" : "inflow", dec);
      expect(a.reduce((s, x) => s + x.amount, 0) + 0).toBe((out ? -charge : charge) + 0);
      for (const x of a) expect(Math.abs(x.amount) % unit).toBe(0);
      expect(new Set(a.map((x) => x.categoryId)).size).toBe(a.length);
    }));
  });

  it("property: monotonic in weight (a heavier category never gets less)", () => {
    fc.assert(fc.property(linesArb, fc.integer({ min: 0, max: 10_000_000 }), (lines, k) => {
      const a = allocate(k * 10, lines, "inflow", 2);
      const weight = new Map<string, number>();
      for (const l of lines) weight.set(l.categoryId, (weight.get(l.categoryId) ?? 0) + l.amount);
      for (const x of a) for (const y of a) {
        if ((weight.get(x.categoryId) ?? 0) > (weight.get(y.categoryId) ?? 0)) expect(x.amount).toBeGreaterThanOrEqual(y.amount);
      }
    }));
  });
});

describe("nudged (D13)", () => {
  it("approximate amounts lose one minor unit", () => {
    expect(nudged(200000, true, 2)).toBe(199990);
    expect(nudged(200000, false, 2)).toBe(200000);
    expect(nudged(5000000, true, 0)).toBe(4999000);
    expect(nudged(10, true, 2)).toBe(10);
  });
  it("scenario 10: a reduced Amazon placeholder keeps the nudge", () => {
    expect(nudged(50000, true, 2)).toBe(49990);
  });
});

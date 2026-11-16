import { describe, expect, it } from "vitest";
import {
  MAX_LINES, MAX_SOLUTIONS, anySubsetFits, enumerateAssignments, fitRange, fits, optionScore, subsetsOf,
} from "../../../src/worker/domain/subsets";
import { input, intent, line, txn } from "./helpers";

const TAX = 0.11;
const L = (id: string, amount: number) => line({ id, categoryId: `cat-${id}`, amount });

describe("fits (§10.6)", () => {
  const R = [L("a", 20000), L("b", 15000), L("c", 50000)];
  it("whole order with tax", () => {
    expect(fitRange(R, TAX)).toEqual({ lo: 81500, hi: 97850 });
    expect(fits(91200, R, TAX)).toBe(true);
    expect(fits(85000, R, TAX)).toBe(true);
    expect(fits(81500, R, TAX)).toBe(true);
    expect(fits(81490, R, TAX)).toBe(false);
    expect(fits(97850, R, TAX)).toBe(true);
    expect(fits(97860, R, TAX)).toBe(false);
  });
  it("subset with tax: 20 + 15 at 6% = 37.10", () => expect(fits(37100, [L("a", 20000), L("b", 15000)], TAX)).toBe(true));
  it("tolerance is capped at 25% of the base", () => {
    const tiny = [line({ id: "x", categoryId: "x", amount: 2000, approximate: true })];
    expect(fitRange(tiny, 0)).toEqual({ lo: 2000 - 500 - 500, hi: 2000 + 1000 });
  });
  it("empty subset never fits", () => expect(fits(0, [], TAX)).toBe(false));
  it("anySubsetFits", () => {
    expect(anySubsetFits(16000, R, TAX)).toBe(true);
    expect(anySubsetFits(5000, R, TAX)).toBe(false);
    expect(anySubsetFits(5000, [], TAX)).toBe(false);
  });
  it("anySubsetFits above MAX_LINES uses the whole range", () => {
    const many = Array.from({ length: MAX_LINES + 1 }, (_, k) => L(`l${k}`, 10000));
    expect(anySubsetFits(50000, many, TAX)).toBe(true);
    expect(anySubsetFits(1000, many, TAX)).toBe(false);
  });
});

describe("subsetsOf", () => {
  it("yields every non-empty subset", () => {
    expect([...subsetsOf([1, 2, 3])].map((s) => s.join(""))).toEqual(["1", "2", "12", "3", "13", "23", "123"]);
  });
  it("is capped at MAX_LINES elements", () => {
    const xs = Array.from({ length: MAX_LINES + 3 }, (_, k) => k);
    let n = 0;
    for (const s of subsetsOf(xs, Number.MAX_SAFE_INTEGER)) n += s.length > 0 ? 1 : 0;
    expect(n).toBe(2 ** MAX_LINES - 1);
  });
});

describe("enumerateAssignments (§10.6)", () => {
  const i = intent({ id: "i", payee: "Amazon", merchantKind: "amazon", date: "2026-11-05",
    lines: [{ id: "a", categoryId: "A", amount: 20000 }, { id: "b", categoryId: "B", amount: 15000 }, { id: "c", categoryId: "C", amount: 50000 }] });
  const inp = input({ intents: [i], txns: [] });
  it("ranks complete coverage first", () => {
    const opts = enumerateAssignments(i, [
      txn({ id: "part", date: "2026-11-05", amount: -37100 }),
      txn({ id: "whole", date: "2026-11-15", amount: -91200 }),
    ], inp);
    expect(opts[0]).toMatchObject({ transactionId: "whole", lineIds: ["a", "b", "c"] });
    expect(opts.some((o) => o.transactionId === "part")).toBe(true);
    for (const o of opts) expect(o.allocation.reduce((s, x) => s + x.amount, 0)).toBe(o.transactionId === "whole" ? -91200 : -37100);
  });
  it("prefers a plausible tax rate between equal subsets", () => {
    const j = intent({ id: "j", payee: "Amazon", merchantKind: "amazon", date: "2026-11-05",
      lines: [{ id: "x", categoryId: "X", amount: 20000 }, { id: "y", categoryId: "Y", amount: 21000 }] });
    const c = txn({ id: "c", date: "2026-11-06", amount: -21400 });
    const opts = enumerateAssignments(j, [c], input({ intents: [j], txns: [] }));
    expect(opts[0]?.lineIds).toEqual(["x"]); // 7% on 20 beats 1.9% on 21
    expect(optionScore(j, c, [j.lines[0]!], 2, 21)).toBeGreaterThan(optionScore(j, c, [j.lines[1]!], 2, 21));
  });
  it("stops at MAX_SOLUTIONS", () => {
    const big = intent({ id: "big", payee: "Amazon", merchantKind: "amazon", date: "2026-11-05",
      lines: Array.from({ length: MAX_LINES }, (_, k) => ({ id: `l${k}`, categoryId: "C", amount: 10000 })) });
    const charges = Array.from({ length: 6 }, (_, k) => txn({ id: `c${k}`, date: "2026-11-06", amount: -(60000 + k * 1000) }));
    const opts = enumerateAssignments(big, charges, input({ intents: [big], txns: [] }));
    expect(opts.length).toBe(MAX_SOLUTIONS);
  });
});

import { describe, expect, it } from "vitest";
import { dateScore, dateWindow, inWindow } from "../../../src/worker/domain/dates";

describe("dateWindow (§10.3)", () => {
  it("per merchant kind", () => {
    expect(dateWindow("in_person", 21)).toEqual({ before: 2, after: 7 });
    expect(dateWindow("online", 21)).toEqual({ before: 2, after: 14 });
    expect(dateWindow("amazon", 21)).toEqual({ before: 2, after: 21 });
    expect(dateWindow("amazon", 30)).toEqual({ before: 2, after: 30 });
    expect(dateWindow("other", 21)).toEqual({ before: 2, after: 10 });
  });
  it("inWindow bounds are inclusive", () => {
    const w = dateWindow("in_person", 21);
    expect(inWindow(-2, w)).toBe(true);
    expect(inWindow(-3, w)).toBe(false);
    expect(inWindow(7, w)).toBe(true);
    expect(inWindow(8, w)).toBe(false);
  });
});

describe("dateScore (§10.3)", () => {
  it("1.0 for 0..2 days", () => {
    for (const d of [0, 1, 2]) expect(dateScore(d, 7)).toBe(1);
  });
  it("0.7 for −2..−1", () => {
    expect(dateScore(-1, 7)).toBe(0.7);
    expect(dateScore(-2, 7)).toBe(0.7);
  });
  it("falls linearly to 0.3 at `after`", () => {
    expect(dateScore(7, 7)).toBeCloseTo(0.3);
    expect(dateScore(4.5, 7)).toBeCloseTo(0.65);
    expect(dateScore(21, 21)).toBeCloseTo(0.3);
  });
  it("0 outside the window", () => {
    expect(dateScore(-3, 7)).toBe(0);
    expect(dateScore(8, 7)).toBe(0);
  });
  it("degenerate window (after ≤ 2) never divides by zero", () => expect(dateScore(2, 2)).toBe(1));
});

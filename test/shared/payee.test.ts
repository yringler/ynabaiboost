import { describe, expect, it } from "vitest";
import { bestPayeeMatch, normalizePayee, payeeSimilarity } from "../../src/shared/payee";

describe("normalizePayee", () => {
  it.each([
    ["COSTCO WHSE #0123", "costco"],
    ["AMZN Mktp US*2K4L", "amazon"],
    ["Amazon.com", "amazon"],
    ["SQ *BLUE BOTTLE COFFEE", "blue bottle coffee"],
    ["TST* Joe's Pizza 1234 NY", "joe s pizza"],
    ["WHOLEFDS MKT 10234", "whole foods"],
    ["Café Olé", "cafe ole"],
    ["WM SUPERCENTER #555", "walmart"],
    ["Target T-1234", "target"],
    ["Prime Video*AB12", "amazon"],
    ["POS DEBIT SHELL OIL 57444", "shell oil"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePayee(input)).toBe(expected);
  });

  it("keeps a lone 2-letter token that could be a state", () => {
    expect(normalizePayee("CA")).toBe("ca");
  });
});

describe("payeeSimilarity", () => {
  it("AMZN Mktp US*2K4L ~ amazon ≥ 0.9", () => {
    expect(payeeSimilarity("amazon", ["AMZN Mktp US*2K4L"])).toBeGreaterThanOrEqual(0.9);
  });
  it('"COSTCO WHSE #0123" vs "Costco" = 1', () => {
    expect(payeeSimilarity("Costco", ["COSTCO WHSE #0123"])).toBe(1);
  });
  it("prefix match gives at least 0.9", () => {
    expect(payeeSimilarity("Trader", ["Trader Joe's"])).toBeGreaterThanOrEqual(0.9);
  });
  it("unrelated payees score low", () => {
    expect(payeeSimilarity("Costco", ["Shell Oil"])).toBeLessThan(0.4);
  });
  it("ignores null names and returns the best", () => {
    expect(payeeSimilarity("Starbucks", [null, "Shell", "STARBUCKS STORE 01234"])).toBe(1);
  });
  it("returns 0 for no names or empty input", () => {
    expect(payeeSimilarity("Costco", [])).toBe(0);
    expect(payeeSimilarity("Costco", [null])).toBe(0);
    expect(payeeSimilarity("", ["Costco"])).toBe(0);
  });
  it("is within [0,1]", () => {
    for (const [a, b] of [["a", "b"], ["xyz corp", "xyz"], ["Uber Eats", "UBER *EATS PENDING"]] as const) {
      const s = payeeSimilarity(a, [b]);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe("bestPayeeMatch", () => {
  const payees = [
    { id: "p1", name: "Costco Wholesale" },
    { id: "p2", name: "Shell" },
    { id: "p3", name: "Target" },
  ];
  it('"Costco" matches cached "Costco Wholesale" (≥ 0.9)', () => {
    expect(bestPayeeMatch("Costco", payees)?.id).toBe("p1");
  });
  it("returns null below min", () => {
    expect(bestPayeeMatch("Trader Joe's", payees)).toBeNull();
  });
  it("prefers the shorter name on ties", () => {
    const tie = [
      { id: "long", name: "Costco Gas Station" },
      { id: "short", name: "Costco" },
    ];
    expect(bestPayeeMatch("costco", tie)?.id).toBe("short");
  });
  it("honours a custom min", () => {
    expect(bestPayeeMatch("Shel", payees, 0.5)?.id).toBe("p2");
  });
});

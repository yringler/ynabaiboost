import { describe, expect, it } from "vitest";
import {
  REVIEW_CAP, baseCandidate, isApprovedImport, looseScore, rawScore, scoreCandidate, scoreDetail, taxedDiff,
} from "../../../src/worker/domain/score";
import { input, intent, txn } from "./helpers";

const costco = intent({ id: "i", payee: "Costco", date: "2026-11-10", total: 200000, approximate: true, accountId: "acc-1" });
const charge = (over: Parameters<typeof txn>[0] extends infer T ? Partial<T> : never = {}) =>
  txn({ id: "t", date: "2026-11-11", amount: -173500, importPayee: "COSTCO WHSE #0123", ...over });

describe("candidate filter (§10.5)", () => {
  const inp = input({ intents: [costco], txns: [] });
  it("accepts a plain import", () => expect(baseCandidate(costco, charge(), inp)).toBe(true));
  it.each([
    ["deleted", { deleted: true }],
    ["transfer", { transferAccountId: "acc-2" }],
    ["not imported", { imported: false }],
    ["wrong sign", { amount: 173500 }],
    ["split", { isSplit: true }],
    ["too early", { date: "2026-11-07" }],
    ["too late", { date: "2026-11-18" }],
  ])("rejects %s", (_n, over) => expect(baseCandidate(costco, charge(over), inp)).toBe(false));
  it("rejects excluded txns and the intent's own placeholder", () => {
    expect(baseCandidate(costco, charge(), input({ intents: [], txns: [], excluded: ["t"] }))).toBe(false);
    expect(baseCandidate({ ...costco, placeholderTxnId: "t" }, charge(), inp)).toBe(false);
  });
  it("explicit account must match", () => {
    const explicit = { ...costco, accountExplicit: true };
    expect(baseCandidate(explicit, charge({ accountId: "acc-2" }), inp)).toBe(false);
    expect(baseCandidate(explicit, charge({ accountId: "acc-1" }), inp)).toBe(true);
  });
  it("inflow intents match positive amounts", () => {
    const refund = { ...costco, direction: "inflow" as const };
    expect(baseCandidate(refund, charge({ amount: 173500 }), inp)).toBe(true);
  });
  it("amount outside tolerance is not a candidate", () => {
    expect(scoreCandidate(costco, charge({ amount: -149000 }), inp)).toBeNull();
    expect(scoreCandidate(costco, charge({ amount: -150000 }), inp)).not.toBeNull();
  });
});

describe("score (§10.5)", () => {
  const inp = input({ intents: [costco], txns: [] });
  it("Costco ~200 vs 173.50 next day on the intent's account", () => {
    // amount 1 − 0.5·26.5/50 = 0.735; date 1; payee 1; +0.05 account
    expect(scoreCandidate(costco, charge(), inp)).toBeCloseTo(0.45 * 0.735 + 0.2 + 0.35 + 0.05, 6);
  });
  it("diff ≤ 10 milliunits counts as exact", () => {
    expect(rawScore(costco, charge({ amount: -200010 }), 21).score).toBeCloseTo(1.05);
  });
  it("payee mismatch is capped below AUTO", () => {
    const s = scoreCandidate(costco, charge({ importPayee: "NETFLIX.COM", amount: -200000, date: "2026-11-10" }), inp);
    expect(s).not.toBeNull();
    expect(s!).toBeLessThanOrEqual(REVIEW_CAP);
  });
  it("approved + categorized imports are review-only", () => {
    const t = charge({ approved: true, categoryId: "cat-x" });
    expect(isApprovedImport(t, inp.uncategorizedIds)).toBe(true);
    const d = scoreDetail(costco, t, inp)!;
    expect(d.reviewOnly).toBe(true);
    expect(d.score).toBeLessThanOrEqual(REVIEW_CAP);
  });
  it("approved but uncategorized imports are normal candidates", () => {
    const d = scoreDetail(costco, charge({ approved: true, categoryId: "cat-uncat" }), inp)!;
    expect(d.reviewOnly).toBe(false);
    expect(scoreDetail(costco, charge({ approved: true, categoryId: null }), inp)!.reviewOnly).toBe(false);
  });
  it("single-line Amazon intents allow tax via fits", () => {
    const amz = intent({ id: "a", payee: "Amazon", merchantKind: "amazon", date: "2026-11-05", total: 85000, approximate: true });
    const t = txn({ id: "c", date: "2026-11-07", amount: -91200, importPayee: "AMZN Mktp US*2K4L" });
    expect(Math.abs(91200 - 85000)).toBeGreaterThan(amz.tolerance);
    expect(scoreCandidate(amz, t, input({ intents: [amz], txns: [] }))).toBeGreaterThanOrEqual(0.8);
    expect(taxedDiff(91200, 85000, 0.11)).toBe(0);
    expect(taxedDiff(80000, 85000, 0.11)).toBe(5000);
    expect(taxedDiff(100000, 85000, 0.11)).toBe(5650);
  });
});

describe("looseScore (§10.9)", () => {
  it("keeps payee matches far off in amount", () => {
    expect(looseScore(costco, charge({ amount: -20000 }), new Set(), 21)).not.toBeNull();
  });
  it("keeps amount matches within 3× tolerance from another payee", () => {
    expect(looseScore(costco, charge({ importPayee: "WALGREENS", amount: -60000 }), new Set(), 21)).not.toBeNull();
    expect(looseScore(costco, charge({ importPayee: "WALGREENS", amount: -40000 }), new Set(), 21)).toBeNull();
  });
  it("drops excluded, split, non-import and wrong-sign txns", () => {
    expect(looseScore(costco, charge(), new Set(["t"]), 21)).toBeNull();
    expect(looseScore(costco, charge({ isSplit: true }), new Set(), 21)).toBeNull();
    expect(looseScore(costco, charge({ imported: false }), new Set(), 21)).toBeNull();
    expect(looseScore(costco, charge({ amount: 173500 }), new Set(), 21)).toBeNull();
  });
});

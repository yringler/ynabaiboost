import { describe, expect, it } from "vitest";
import { draftPrecision, draftSums, draftToState, emptyDraft, resolvePayeeId, stateToIntentCreate, type DraftState } from "../../src/client/lib/draft";
import type { IntentDraft } from "../../src/shared/schemas";

const base: IntentDraft = {
  payee: "Amazon", payeeId: "p-amzn", merchantKind: "amazon", direction: "outflow", date: "2026-11-16",
  accountId: null, accountExplicit: false, totalAmount: 85_000, approximate: true, memo: null,
  lines: [
    { description: "phone case", categoryId: "c1", amount: 20_000, approximate: true, confidence: "high" },
    { description: "book", categoryId: "c2", amount: 15_000, approximate: true, confidence: "low" },
    { description: "diapers", categoryId: "c3", amount: 50_000, approximate: false, confidence: "medium" },
  ],
};

const withLine = (d: DraftState, i: number, patch: Partial<DraftState["lines"][number]>): DraftState => ({
  ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
});

describe("draft state", () => {
  it("round-trips a parsed draft into a valid IntentCreate", () => {
    const s = draftToState(base, 2, true);
    expect(s.totalText).toBe("85.00");
    const r = stateToIntentCreate(s, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalAmount).toBe(85_000);
    expect(r.value.lines.map((l) => l.amount)).toEqual([20_000, 15_000, 50_000]);
    expect(r.value.createPlaceholder).toBe(true);
    expect(r.value.approximate).toBe(true);
  });

  it("requires multi-line amounts to add up to the total", () => {
    const s = withLine(draftToState(base, 2, true), 2, { amountText: "40" });
    expect(draftSums(s, 2)).toMatchObject({ total: 85_000, lineSum: 75_000, balanced: false });
    const r = stateToIntentCreate(s, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("Item amounts must add up to the total");
  });

  it("requires every line to have an amount when there are several", () => {
    const s = withLine(draftToState(base, 2, true), 1, { amountText: "" });
    const r = stateToIntentCreate(s, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /Item 2: needs an amount/.test(e))).toBe(true);
  });

  it("requires a category on every line", () => {
    const s = withLine(draftToState(base, 2, true), 0, { categoryId: null });
    const r = stateToIntentCreate(s, 2);
    expect(r.ok).toBe(false);
  });

  it("gives a single line the total and the draft's approximate flag", () => {
    const one: IntentDraft = { ...base, lines: [{ description: "groceries", categoryId: "c1", amount: null, approximate: false, confidence: null }], totalAmount: 200_000 };
    const r = stateToIntentCreate(draftToState(one, 2, false), 2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines[0]).toMatchObject({ amount: 200_000, approximate: true });
      expect(r.value.createPlaceholder).toBe(false);
    }
  });

  it("an empty manual draft fails until filled", () => {
    const d = emptyDraft("2026-11-16", true, "coffee");
    expect(stateToIntentCreate(d, 2).ok).toBe(false);
    const filled: DraftState = withLine({ ...d, payee: "Starbucks", totalText: "6.45" }, 0, { categoryId: "c-dine" });
    const r = stateToIntentCreate(filled, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0]).toMatchObject({ description: "coffee", amount: 6_450 });
  });

  it("resolvePayeeId matches cached payees fuzzily", () => {
    const payees = [{ id: "p1", name: "Costco Wholesale" }, { id: "p2", name: "Target" }];
    expect(resolvePayeeId("Costco", payees)).toBe("p1");
    expect(resolvePayeeId("Some new shop", payees)).toBeNull();
    expect(resolvePayeeId("  ", payees)).toBeNull();
  });

  it("carries order facts to IntentCreate; an Amazon total with tax balances against items + tax", () => {
    const facts = { totalHasCents: true, lineAmounts: [20_000, 15_000, 50_000], lineQuantities: [1, 1, 1], itemSubtotal: null,
      tax: 6_800, shipping: null, discount: null, giftCard: null, grandTotal: 91_800, shipments: [], clarityNote: null };
    const s = draftToState({ ...base, totalAmount: 91_800, approximate: false, facts }, 2, true);
    expect(draftSums(s, 2).balanced).toBe(true);
    const r = stateToIntentCreate(s, 2);
    expect(r.ok && r.value.facts).toEqual(facts);
    expect(draftPrecision(s, "case 20.00 book 15.00 diapers 50.00 tax 6.80 total 91.80", 2).level).toBe("approximate"); // lines flagged ≈ in base
    const exact = { ...s, lines: s.lines.map((l) => ({ ...l, approximate: false })) };
    expect(draftPrecision(exact, "case 20.00 book 15.00 diapers 50.00 tax 6.80 total 91.80", 2).level).toBe("exact");
    // without facts the old rule stands
    expect(draftSums({ ...s, facts: null }, 2).balanced).toBe(false);
  });
});

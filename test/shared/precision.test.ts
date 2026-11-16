// shared/precision.ts: the deterministic trust boundary between Claude's reported facts and the matcher.
import { describe, expect, it } from "vitest";
import { assessPrecision, precisionInfo, statedAmounts, type OrderFacts, type PrecisionInput } from "../../src/shared/precision";

const facts = (o: Partial<OrderFacts> = {}, lineAmounts: (number | null)[] = []): OrderFacts => ({
  totalHasCents: true, lineAmounts, lineQuantities: lineAmounts.map(() => 1),
  itemSubtotal: null, tax: null, shipping: null, discount: null, giftCard: null, grandTotal: null, shipments: [], clarityNote: null, ...o,
});
const simple = (total: number, approximate = false): PrecisionInput =>
  ({ merchantKind: "in_person", totalAmount: total, approximate, lines: [{ amount: total, approximate }] });
const amazon = (amounts: number[], f: Partial<OrderFacts>, total: number | null = null): PrecisionInput => ({
  merchantKind: "amazon", totalAmount: total ?? f.grandTotal ?? null, approximate: false,
  lines: amounts.map((a) => ({ amount: a, approximate: false })), facts: facts(f, amounts),
});

describe("statedAmounts", () => {
  it("reads amounts with explicit cents, thousands separators and decimal commas", () => {
    const s = statedAmounts("Grand Total: $1,234.56 · 12,99 € · $5 · Qty: 2 · 0.5 · order 112-1234567", 2);
    expect([...s.exact].sort((a, b) => a - b)).toEqual([500, 12_990, 1_234_560]);
    expect(s.ints.has(2)).toBe(true);
    expect(s.exact.has(5_000)).toBe(false);          // "$5" has no cents
    expect(s.exact.has(1_234_567_000)).toBe(false);  // order numbers are not amounts
  });

  it("every integer is exact for 0-decimal currencies", () => {
    expect(statedAmounts("ラーメン 1200円", 0).exact.has(1_200_000)).toBe(true);
  });
});

describe("assessPrecision — non-Amazon", () => {
  it("exact only when the cents are literally in the text and there is no hedge", () => {
    expect(assessPrecision(simple(43_170), "Shell 43.17 gas", 2)).toMatchObject({ level: "exact", totalExact: true });
    expect(assessPrecision(simple(43_170, true), "about 43.17 at Shell", 2).level).toBe("approximate");
    expect(assessPrecision(simple(43_000), "43 at Shell", 2)).toMatchObject({ level: "approximate", reasons: ["No exact amount with cents in your note"] });
    // the model claims 43.17 but the user said 43.71
    expect(assessPrecision(simple(43_170), "Shell 43.71", 2).level).toBe("approximate");
    // the model's "no cents" flag can only downgrade
    expect(assessPrecision({ ...simple(43_170), facts: facts({ totalHasCents: false }, [43_170]) }, "Shell 43.17", 2).level).toBe("approximate");
  });
});

describe("assessPrecision — Amazon", () => {
  const PAGE = "Charger $24.99\nNovel $15.99\nItem(s) Subtotal: $40.98\nEstimated tax: $3.28\nGrand Total: $44.26";

  it("items + tax + grand total that reconcile → exact with a plan", () => {
    const r = assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, itemSubtotal: 40_980 }), PAGE, 2);
    expect(r.level).toBe("exact");
    expect(r.plan).toEqual({ cardTotal: 44_260, tax: 3_280, shipping: 0, discount: 0, shipments: null });
  });

  it("tax is derived from an exact grand total when the page doesn't list it", () => {
    const r = assessPrecision(amazon([24_990, 15_990], { grandTotal: 44_260 }), "charger 24.99, novel 15.99, total 44.26", 2);
    expect(r.plan?.tax).toBe(3_280);
  });

  it("downgrades: estimated items, missing total, numbers not in the text, sums that don't reconcile", () => {
    expect(assessPrecision(amazon([24_990, 15_990], {}), "charger 24.99 and a novel", 2).reasons[0]).toMatch(/estimates/);
    expect(assessPrecision(amazon([24_990, 15_990], {}), "charger 24.99 novel 15.99", 2).reasons[0]).toMatch(/order total/);
    expect(assessPrecision(amazon([24_990, 15_990], { tax: 3_290, grandTotal: 44_260 }), PAGE, 2).reasons[0]).toBe("Couldn't find the tax in your text");
    expect(assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 45_260 }), `${PAGE}\nGrand Total: $45.26`, 2).reasons[0])
      .toBe("The amounts don't add up to the order total");
    expect(assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, itemSubtotal: 50_000 }), `${PAGE} 50.00`, 2).reasons[0])
      .toMatch(/subtotal/);
  });

  it("a gift card (verified or not) → approximate, no plan", () => {
    const g = assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, giftCard: 10_000 }), `${PAGE}\nGift Card: -$10.00`, 2);
    expect(g).toMatchObject({ level: "approximate", plan: null });
    expect(g.reasons[0]).toMatch(/Gift card/);
    expect(assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, giftCard: 7_000 }), PAGE, 2).level).toBe("approximate");
  });

  it("quantities: a line total that is written as unit price × Qty is exact", () => {
    const r = assessPrecision(amazon([25_980], { grandTotal: 27_800 }), "Socks $12.99 Qty: 2\nGrand Total: $27.80", 2);
    expect(r.linesExact).toEqual([false]);                  // no quantity reported → 25.98 is not in the text
    const withQty = amazon([25_980], { grandTotal: 27_800 });
    if (withQty.facts) withQty.facts.lineQuantities = [2];
    expect(assessPrecision(withQty, "Socks $12.99 Qty: 2\nGrand Total: $27.80", 2)).toMatchObject({ level: "exact", linesExact: [true] });
  });

  it("shipments: kept only as a full partition of the unedited lines; totals only if written and adding up", () => {
    const text = `${PAGE}\nShipment 1: $26.99\nShipment 2: $17.27`;
    const ok = assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, shipments: [{ lines: [0], total: 26_990 }, { lines: [1], total: 17_270 }] }), text, 2);
    expect(ok.plan?.shipments).toEqual([{ lines: [0], total: 26_990 }, { lines: [1], total: 17_270 }]);
    const notWritten = assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, shipments: [{ lines: [0], total: 26_990 }, { lines: [1], total: 17_270 }] }), PAGE, 2);
    expect(notWritten.plan?.shipments).toEqual([{ lines: [0], total: null }, { lines: [1], total: null }]);
    const overlap = assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, shipments: [{ lines: [0, 1], total: null }, { lines: [1], total: null }] }), PAGE, 2);
    expect(overlap.plan?.shipments).toBeNull();
    // the user edited a line amount on the confirm screen: the snapshot no longer matches → shipments are dropped
    const edited = amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, shipments: [{ lines: [0], total: null }, { lines: [1], total: null }] });
    if (edited.facts) edited.facts.lineAmounts = [24_990, 15_000];
    expect(assessPrecision(edited, PAGE, 2).plan?.shipments).toBeNull();
  });

  it("unplaceable shipping or promotions → the whole order is one predicted charge", () => {
    const text = PAGE.replace("Grand Total: $44.26", "Shipping: $5.99\nGrand Total: $50.25");
    const r = assessPrecision(amazon([24_990, 15_990], { tax: 3_280, shipping: 5_990, grandTotal: 50_250 }), text, 2);
    expect(r.plan?.shipments).toEqual([{ lines: [0, 1], total: 50_250 }]);
  });

  it("precisionInfo: the first reason, else the model's clarity note", () => {
    const a = assessPrecision(amazon([24_990, 15_990], { tax: 3_280, grandTotal: 44_260, clarityNote: "  Looks complete.  " }), PAGE, 2);
    expect(precisionInfo(a)).toEqual({ level: "exact", note: "Looks complete." });
    expect(precisionInfo(assessPrecision(simple(40_000, true), "about 40", 2))).toEqual({ level: "approximate", note: "The amount is approximate" });
  });

  it("a one-item order whose single line carries the order total uses the item price from the snapshot", () => {
    const d: PrecisionInput = { merchantKind: "amazon", totalAmount: 26_990, approximate: false,
      lines: [{ amount: 26_990, approximate: false }], facts: facts({ tax: 2_000, grandTotal: 26_990 }, [24_990]) };
    expect(assessPrecision(d, "Charger $24.99\nTax $2.00\nGrand Total $26.99", 2)).toMatchObject({ level: "exact", plan: { cardTotal: 26_990, tax: 2_000 } });
  });
});

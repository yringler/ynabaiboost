// WP4: ParsedUtterance → IntentDrafts (§9.4 "Parsing"): ref mapping, amounts, lines, dates, payees.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Account, Category, Payee } from "../../../src/shared/schemas";
import { toDrafts, type PostprocessCtx } from "../../../src/worker/ai/postprocess";
import { renderCatalog } from "../../../src/worker/ai/prompts";
import type { ParsedLine, ParsedTransaction, ParsedUtterance } from "../../../src/worker/ai/schemas";

const categories: Category[] = [
  { id: "cat-groc", groupId: "g", groupName: "Everyday", name: "Groceries" },
  { id: "cat-elec", groupId: "g", groupName: "Everyday", name: "Electronics" },
  { id: "cat-gift", groupId: "g", groupName: "Everyday", name: "Gifts" },
  { id: "cat-baby", groupId: "g", groupName: "Kids", name: "Baby" },
];
const accounts: Account[] = [{ id: "acc-visa", name: "Visa", type: "creditCard", onBudget: true, closed: false, directImportLinked: true }];
const payees: Payee[] = [{ id: "p-costco", name: "Costco Wholesale" }, { id: "p-amzn", name: "Amazon" }];
const TODAY = "2026-11-16";
const ctx: PostprocessCtx = { catalog: renderCatalog({ categories, accounts, payees }), payees, today: TODAY, decimalDigits: 2 };

const line = (o: Partial<z.infer<typeof ParsedLine>> = {}): z.infer<typeof ParsedLine> => ({
  description: "groceries", category_ref: "c1", category_confidence: "high", amount: null, amount_is_estimate: false, ...o,
});
const txn = (o: Partial<z.infer<typeof ParsedTransaction>> = {}): z.infer<typeof ParsedTransaction> => ({
  payee: "Costco", merchant_kind: "in_person", direction: "outflow", date: TODAY, account_ref: null,
  total_amount: 200, total_is_approximate: true, memo: null, lines: [line()], ...o,
});
const ok = (...transactions: z.infer<typeof ParsedTransaction>[]): z.infer<typeof ParsedUtterance> =>
  ({ status: "ok", clarification_question: null, transactions });

describe("toDrafts", () => {
  it("maps refs, payee spelling and amounts for a simple note", () => {
    const r = toDrafts(ok(txn({ account_ref: "a1" })), ctx);
    expect(r.status).toBe("ok");
    expect(r.warnings).toEqual([]);
    expect(r.drafts).toEqual([{
      payee: "Costco Wholesale", payeeId: "p-costco", merchantKind: "in_person", direction: "outflow", date: TODAY,
      accountId: "acc-visa", accountExplicit: true, totalAmount: 200_000, approximate: true, memo: null,
      lines: [{ description: "groceries", categoryId: "cat-groc", amount: 200_000, approximate: true, confidence: "high" }],
    }]);
  });

  it("drops unknown category refs with a warning; unknown account refs become null", () => {
    const r = toDrafts(ok(txn({ account_ref: "a9", lines: [line({ category_ref: "c99" })] })), ctx);
    const d = r.drafts[0]!;
    expect(d.lines[0]).toMatchObject({ categoryId: null, confidence: "low" });
    expect(d.accountId).toBeNull();
    expect(d.accountExplicit).toBe(false);
    expect(r.warnings).toContain('unknown category "c99" dropped');
  });

  it("new payee → payeeId null and a warning", () => {
    const r = toDrafts(ok(txn({ payee: "Bob's Bikes" })), ctx);
    expect(r.drafts[0]).toMatchObject({ payee: "Bob's Bikes", payeeId: null });
    expect(r.warnings).toContain('new payee "Bob\'s Bikes"');
  });

  it("negative amounts are made positive and flip the direction", () => {
    const r = toDrafts(ok(txn({ total_amount: -12.5, total_is_approximate: false, lines: [line({ amount: -12.5 })] })), ctx);
    expect(r.drafts[0]).toMatchObject({ direction: "inflow", totalAmount: 12_500, lines: [{ amount: 12_500 }] });
  });

  it("rounds to the currency minor unit", () => {
    const r = toDrafts(ok(txn({ total_amount: 12.345, lines: [line({ amount: null })] })), ctx);
    expect(r.drafts[0]?.totalAmount).toBe(12_350);
    const yen = toDrafts(ok(txn({ total_amount: 1234.4, lines: [line()] })), { ...ctx, decimalDigits: 0 });
    expect(yen.drafts[0]?.totalAmount).toBe(1_234_000);
  });

  it("total null + every line has an amount → total = sum of lines", () => {
    const r = toDrafts(ok(txn({ merchant_kind: "amazon", total_amount: null, lines: [
      line({ description: "phone case", category_ref: "c2", amount: 20 }), line({ description: "book", category_ref: "c3", amount: 15.5 }),
    ] })), ctx);
    expect(r.drafts[0]?.totalAmount).toBe(35_500);
    expect(r.warnings).toEqual([]);
  });

  it("single line without an amount takes the total", () => {
    const r = toDrafts(ok(txn({ total_amount: 47.23, total_is_approximate: false, lines: [line({ amount: null })] })), ctx);
    expect(r.drafts[0]?.lines[0]).toMatchObject({ amount: 47_230, approximate: false });
  });

  it("several lines with some amounts missing → warning", () => {
    const r = toDrafts(ok(txn({ lines: [line({ amount: 50 }), line({ category_ref: "c4", amount: null })] })), ctx);
    expect(r.drafts[0]?.lines[1]?.amount).toBeNull();
    expect(r.warnings).toContain("some items have no amount; enter them before saving");
  });

  it("non-Amazon lines that don't add up → warning; Amazon (pre-tax) does not warn", () => {
    const lines = [line({ amount: 50 }), line({ category_ref: "c4", amount: 20 })];
    const r = toDrafts(ok(txn({ total_amount: 100, total_is_approximate: false, lines })), ctx);
    expect(r.warnings).toContain("item amounts don't add up to the total");
    const a = toDrafts(ok(txn({ merchant_kind: "amazon", total_amount: 100, lines })), ctx);
    expect(a.warnings).toEqual([]);
  });

  it("approximate totals tolerate small differences", () => {
    const r = toDrafts(ok(txn({ total_amount: 200, total_is_approximate: true, lines: [line({ amount: 120 }), line({ category_ref: "c4", amount: 75 })] })), ctx);
    expect(r.warnings).toEqual([]);
  });

  it("future dates are clamped to today with a warning", () => {
    const r = toDrafts(ok(txn({ date: "2026-11-20" })), ctx);
    expect(r.drafts[0]?.date).toBe(TODAY);
    expect(r.warnings).toContain("date 2026-11-20 is in the future; using today");
  });

  it("dates older than 60 days are kept with a warning; invalid dates become today", () => {
    const old = toDrafts(ok(txn({ date: "2026-08-01" })), ctx);
    expect(old.drafts[0]?.date).toBe("2026-08-01");
    expect(old.warnings).toContain("date 2026-08-01 is more than 60 days ago");
    const bad = toDrafts(ok(txn({ date: "last tuesday" })), ctx);
    expect(bad.drafts[0]?.date).toBe(TODAY);
    expect(bad.warnings[0]).toMatch(/could not read the date/);
  });

  it("no lines → one line from memo/payee with the total", () => {
    const r = toDrafts(ok(txn({ lines: [], memo: "snacks" })), ctx);
    expect(r.drafts[0]?.lines).toEqual([{ description: "snacks", categoryId: null, amount: 200_000, approximate: true, confidence: "low" }]);
  });

  it("several transactions get numbered warnings", () => {
    const r = toDrafts(ok(txn(), txn({ payee: "Nowhere Cafe" })), ctx);
    expect(r.drafts).toHaveLength(2);
    expect(r.warnings).toEqual(['#2: new payee "Nowhere Cafe"']);
  });

  it("not_a_transaction → no drafts; needs_clarification keeps drafts and the question", () => {
    expect(toDrafts({ status: "not_a_transaction", clarification_question: null, transactions: [txn()] }, ctx))
      .toEqual({ status: "not_a_transaction", question: null, drafts: [], warnings: [] });
    const q = toDrafts({ status: "needs_clarification", clarification_question: "How much was it?",
      transactions: [txn({ total_amount: null, lines: [line()] })] }, ctx);
    expect(q.status).toBe("needs_clarification");
    expect(q.question).toBe("How much was it?");
    expect(q.drafts[0]?.totalAmount).toBeNull();
  });

  it("ok with no transactions → not_a_transaction", () => {
    expect(toDrafts(ok(), ctx).status).toBe("not_a_transaction");
  });

  it("caps drafts at 10 and lines at 20", () => {
    const r = toDrafts(ok(...Array.from({ length: 12 }, () => txn())), ctx);
    expect(r.drafts).toHaveLength(10);
    const many = toDrafts(ok(txn({ merchant_kind: "amazon", total_amount: null, lines: Array.from({ length: 25 }, () => line({ amount: 1 })) })), ctx);
    expect(many.drafts[0]?.lines).toHaveLength(20);
    expect(many.warnings).toContain("only the first 20 items were kept");
  });

  it("empty payee becomes a placeholder name with a warning", () => {
    const r = toDrafts(ok(txn({ payee: "  " })), ctx);
    expect(r.drafts[0]?.payee).toBe("Unknown payee");
    expect(r.warnings).toContain("no payee recognised");
  });
});

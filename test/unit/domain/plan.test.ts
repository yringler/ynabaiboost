// planReconciliation edge cases beyond the §13 scenario fixtures.
import { describe, expect, it } from "vitest";
import { planReconciliation } from "../../../src/worker/domain/plan";
import { MAX_LINES } from "../../../src/worker/domain/subsets";
import type { Decision } from "../../../src/worker/domain/types";
import { input, intent, txn } from "./helpers";

const kinds = (ds: Decision[]) => ds.map((d) => d.kind);
const costco = (over: Partial<Parameters<typeof intent>[0]> = {}) =>
  intent({ id: "i1", payee: "Costco", date: "2026-11-10", total: 200000, approximate: true, categoryId: "cat-g", ...over });
const costcoTxn = (over: Partial<Parameters<typeof txn>[0]> = {}) =>
  txn({ id: "t1", date: "2026-11-11", amount: -173500, importPayee: "COSTCO WHSE #0123", ...over });

describe("single-charge assignment (§10.5)", () => {
  it("nothing to do without candidates", () => {
    expect(planReconciliation(input({ intents: [costco()], txns: [] }))).toEqual([]);
  });

  it("one intent, two close charges → review with both options, best first", () => {
    const ds = planReconciliation(input({ intents: [costco()], txns: [costcoTxn(), costcoTxn({ id: "t2", amount: -176000 })] }));
    expect(ds).toHaveLength(1);
    const r = ds[0]!;
    expect(r.kind).toBe("review");
    if (r.kind !== "review") return;
    expect(r.reviewKind).toBe("ambiguous_match");
    expect(r.options.map((o) => o.transactionId)).toEqual(["t2", "t1"]);
    expect(r.options.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(r.options[0]!.score).toBeGreaterThanOrEqual(r.options[1]!.score);
  });

  it("at most 3 review options", () => {
    const txns = [0, 1, 2, 3, 4].map((k) => costcoTxn({ id: `t${k}`, amount: -(190000 + k * 100) }));
    const r = planReconciliation(input({ intents: [costco()], txns }))[0];
    expect(r?.kind === "review" && r.options.length).toBe(3);
  });

  it("a clear winner with a weak runner-up applies", () => {
    const ds = planReconciliation(input({ intents: [costco()], txns: [
      costcoTxn({ amount: -199000, date: "2026-11-10" }),
      costcoTxn({ id: "t2", amount: -160000, date: "2026-11-16" }),
    ] }));
    expect(ds).toEqual([expect.objectContaining({ kind: "apply", txnId: "t1" })]);
  });

  it("two intents, two well separated charges → both apply", () => {
    const ds = planReconciliation(input({
      intents: [costco(), intent({ id: "i2", payee: "Shell", date: "2026-11-10", total: 40000, approximate: true })],
      txns: [costcoTxn(), txn({ id: "t2", date: "2026-11-10", amount: -41230, importPayee: "SHELL OIL 57444" })],
    }));
    expect(ds).toHaveLength(2);
    expect(ds).toContainEqual(expect.objectContaining({ kind: "apply", intentId: "i1", txnId: "t1" }));
    expect(ds).toContainEqual(expect.objectContaining({ kind: "apply", intentId: "i2", txnId: "t2" }));
  });

  it("a txn taken by a strong match is not counted against the next intent", () => {
    // i1 strongly prefers t1; i2 (also Costco, later) likes t1 a little and t2 well.
    const ds = planReconciliation(input({
      intents: [costco({ total: 173500, approximate: false }), costco({ id: "i2", date: "2026-11-14", total: 90000, approximate: true })],
      txns: [costcoTxn({ date: "2026-11-10" }), costcoTxn({ id: "t2", date: "2026-11-14", amount: -88000 })],
    }));
    expect(ds).toContainEqual(expect.objectContaining({ kind: "apply", intentId: "i1", txnId: "t1" }));
    expect(ds).toContainEqual(expect.objectContaining({ kind: "apply", intentId: "i2", txnId: "t2" }));
  });

  it("multi-line intent applies as a split with an exact allocation", () => {
    const i = intent({ id: "i1", payee: "Target", date: "2026-11-10", lines: [
      { id: "a", categoryId: "home", amount: 30000, approximate: true }, { id: "b", categoryId: "kids", amount: 20000, approximate: true },
    ], total: 50000, approximate: true });
    const ds = planReconciliation(input({ intents: [i], txns: [txn({ id: "t", date: "2026-11-10", amount: -51230, importPayee: "TARGET T-1234" })] }));
    expect(ds).toEqual([expect.objectContaining({
      kind: "apply", matchKind: "split", lineIds: ["a", "b"],
      allocation: [expect.objectContaining({ categoryId: "home", amount: -30740 }), expect.objectContaining({ categoryId: "kids", amount: -20490 })],
    })]);
  });

  it("matched lines are not re-allocated (partial intent)", () => {
    const i = intent({ id: "i1", payee: "Target", date: "2026-11-10", status: "partial", lines: [
      { id: "a", categoryId: "home", amount: 30000, status: "matched" }, { id: "b", categoryId: "kids", amount: 20000 },
    ], total: 50000 });
    const ds = planReconciliation(input({ intents: [{ ...i, total: 20000 }], txns: [txn({ id: "t", date: "2026-11-10", amount: -20000, importPayee: "TARGET" })] }));
    expect(ds).toEqual([expect.objectContaining({ kind: "apply", lineIds: ["b"], matchKind: "single" })]);
  });

  it("intents in review or kept final are ignored; fully matched intents are skipped", () => {
    const ds = planReconciliation(input({
      intents: [
        costco({ status: "review" }), costco({ id: "i2", placeholderStatus: "final" }),
        intent({ id: "i3", payee: "Costco", date: "2026-11-10", lines: [{ id: "x", categoryId: "c", amount: 173500, status: "matched" }] }),
      ],
      txns: [costcoTxn()],
    }));
    expect(ds).toEqual([]);
  });

  it("an Amazon single-line intent never auto-applies a charge that fits another open Amazon intent", () => {
    const a = intent({ id: "a1", payee: "Amazon", merchantKind: "amazon", date: "2026-11-05", total: 20000, approximate: false });
    const other = intent({ id: "a2", payee: "Amazon", merchantKind: "amazon", date: "2026-11-01", status: "review",
      lines: [{ id: "x", categoryId: "c", amount: 20000 }, { id: "y", categoryId: "d", amount: 5000 }] });
    const t = txn({ id: "c", date: "2026-11-06", amount: -21400, importPayee: "AMZN Mktp US*1" });
    const ds = planReconciliation(input({ intents: [a], others: [other], txns: [t] }));
    expect(kinds(ds)).toEqual(["review"]);
    const alone = planReconciliation(input({ intents: [a], txns: [t] }));
    expect(kinds(alone)).toEqual(["apply"]);
  });
});

describe("Amazon multi-charge (§10.6)", () => {
  const amazon = (over: Partial<Parameters<typeof intent>[0]> = {}) => intent({
    id: "i1", payee: "Amazon", merchantKind: "amazon", date: "2026-11-05",
    lines: [{ id: "a", categoryId: "A", amount: 20000 }, { id: "b", categoryId: "B", amount: 15000 }, { id: "c", categoryId: "C", amount: 50000 }],
    ...over,
  });
  const amzTxn = (id: string, amount: number, date = "2026-11-07", over: Partial<Parameters<typeof txn>[0]> = {}) =>
    txn({ id, date, amount, importPayee: "AMZN Mktp US*2K4L", ...over });

  it("no fitting charge yet → no decision", () => {
    expect(planReconciliation(input({ intents: [amazon()], txns: [amzTxn("x", -300000)] }))).toEqual([]);
  });

  it("two whole-order fits → review, not apply", () => {
    const ds = planReconciliation(input({ intents: [amazon()], txns: [amzTxn("c1", -91200), amzTxn("c2", -90100, "2026-11-08")] }));
    expect(ds).toEqual([expect.objectContaining({ kind: "review", reviewKind: "amazon_split", intentId: "i1" })]);
  });

  it("an already-approved whole-order charge goes to review", () => {
    const ds = planReconciliation(input({ intents: [amazon()], txns: [amzTxn("c1", -91200, "2026-11-07", { approved: true, categoryId: "cat-x" })] }));
    expect(kinds(ds)).toEqual(["review"]);
  });

  it("a whole-order charge that also fits an intent outside this run blocks auto-apply", () => {
    const other = amazon({ id: "o1", status: "review", lines: [{ id: "z", categoryId: "Z", amount: 85000 }] });
    const ds = planReconciliation(input({ intents: [amazon()], others: [other], txns: [amzTxn("c1", -91200)] }));
    expect(ds).toEqual([expect.objectContaining({ kind: "review", intentId: "i1", reviewKind: "amazon_split" })]);
  });

  it("non-Amazon payees and charges before the window are ignored", () => {
    const ds = planReconciliation(input({ intents: [amazon()], txns: [
      txn({ id: "w", date: "2026-11-07", amount: -91200, importPayee: "WALMART" }),
      amzTxn("early", -91200, "2026-11-02"),
    ] }));
    expect(ds).toEqual([]);
  });

  it("only the MAX_CHARGES closest charges are considered", () => {
    // 7 single-item fits: the farthest one (the only whole-order fit) is cut by the cap → review, not apply.
    const near = [1, 2, 3, 4, 5, 6].map((k) => amzTxn(`n${k}`, -21000, `2026-11-0${5 + (k % 3)}`));
    const ds = planReconciliation(input({ intents: [amazon()], txns: [...near, amzTxn("far", -91200, "2026-11-20")] }));
    expect(kinds(ds)).toEqual(["review"]);
    const r = ds[0];
    expect(r?.kind === "review" && r.options.every((o) => o.transactionId !== "far")).toBe(true);
  });

  it(`more than ${MAX_LINES} open lines → too_complex review, no options`, () => {
    const lines = Array.from({ length: MAX_LINES + 1 }, (_, k) => ({ id: `l${k}`, categoryId: "C", amount: 1000 }));
    const ds = planReconciliation(input({ intents: [amazon({ lines })], txns: [amzTxn("c", -13000)] }));
    expect(ds).toEqual([expect.objectContaining({ kind: "review", reviewKind: "too_complex", options: [] })]);
  });

  it("at most 5 options in an amazon_split review", () => {
    const ds = planReconciliation(input({ intents: [amazon()], txns: [amzTxn("c1", -21000), amzTxn("c2", -16000), amzTxn("c3", -52000), amzTxn("c4", -37000)] }));
    const r = ds[0];
    expect(r?.kind === "review" && r.options.length).toBeLessThanOrEqual(5);
  });

  it("partial: the remaining lines of a partially matched order still apply as a whole", () => {
    const i = amazon({ status: "partial", lines: [
      { id: "a", categoryId: "A", amount: 20000, status: "matched" }, { id: "b", categoryId: "B", amount: 15000 }, { id: "c", categoryId: "C", amount: 50000 },
    ] });
    const ds = planReconciliation(input({ intents: [i], txns: [amzTxn("c9", -69300)] }));
    expect(ds).toEqual([expect.objectContaining({ kind: "apply", lineIds: ["b", "c"], matchKind: "amazon_subset" })]);
  });
});

describe("YNAB auto-match detection (§10.7)", () => {
  const withPh = (over: Partial<Parameters<typeof intent>[0]> = {}) =>
    costco({ placeholderTxnId: "p1", placeholderStatus: "created", ...over });

  it("an untouched placeholder produces nothing", () => {
    const ds = planReconciliation(input({ intents: [withPh()], txns: [txn({ id: "p1", date: "2026-11-10", amount: -199990, payee: "Costco", imported: false })] }));
    expect(ds).toEqual([]);
  });

  it("date outside the window → ynab_matched_other", () => {
    const ds = planReconciliation(input({ intents: [withPh()], txns: [
      txn({ id: "p1", date: "2026-11-30", amount: -199990, payee: "Costco", importPayee: "COSTCO WHSE" }),
    ] }));
    expect(ds).toEqual([expect.objectContaining({ kind: "review", reviewKind: "ynab_matched_other", txnId: "p1" })]);
  });

  it("merged in place without import names falls back to the payee name", () => {
    const ds = planReconciliation(input({ intents: [withPh()], txns: [
      txn({ id: "p1", date: "2026-11-10", amount: -199990, payee: "Costco", matchedTransactionId: "imp-1" }),
    ] }));
    expect(kinds(ds)).toEqual(["ynab_auto"]);
  });

  it("a partner already claimed elsewhere is left alone", () => {
    const ds = planReconciliation(input({ intents: [withPh()], excluded: ["t9"], txns: [
      txn({ id: "p1", date: "2026-11-10", amount: -199990, payee: "Costco", imported: false }),
      txn({ id: "t9", date: "2026-11-10", amount: -199990, importPayee: "COSTCO", matchedTransactionId: "p1" }),
    ] }));
    expect(ds).toEqual([]);
  });

  it("placeholder_missing still lets the intent match an import", () => {
    const ds = planReconciliation(input({ intents: [withPh()], txns: [costcoTxn()] }));
    expect(kinds(ds)).toEqual(["placeholder_missing", "apply"]);
  });
});

describe("finalize pre-pass (§10.9)", () => {
  it("skips tagged txns that already have a live match (excluded)", () => {
    const i = costco({ shortRef: "K3F9QX" });
    const ds = planReconciliation(input({ intents: [i], excluded: ["t1"], txns: [costcoTxn({ memo: "[aib:K3F9QX]" })] }));
    expect(ds).toEqual([]);
  });
  it("ignores the tag on the intent's own (unmerged) placeholder", () => {
    const i = costco({ shortRef: "K3F9QX", placeholderTxnId: "p1", placeholderStatus: "created" });
    const ds = planReconciliation(input({ intents: [i], txns: [txn({ id: "p1", date: "2026-11-10", amount: -199990, imported: false, memo: "≈ x [aib:K3F9QX]" })] }));
    expect(ds).toEqual([]);
  });
});

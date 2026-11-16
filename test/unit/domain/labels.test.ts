import { describe, expect, it } from "vitest";
import { fmtAmount, fmtDate, optionLabel, txnPayee } from "../../../src/worker/domain/labels";
import { line, txn } from "./helpers";

describe("labels", () => {
  const t = txn({ id: "t", date: "2026-11-14", amount: -173500, payee: "Costco", importPayee: "COSTCO WHSE" });
  const o = { id: "o1", intentId: "i", transactionId: "t", lineIds: ["a", "b"], allocation: [], score: 1 };
  it("single option", () => expect(optionLabel(o, t, [], 2, { subset: false })).toBe("Costco 173.50 on Nov 14"));
  it("subset option", () => {
    const lines = [line({ id: "a", categoryId: "x", amount: 1, description: "phone case" }), line({ id: "b", categoryId: "y", amount: 1, description: "book" })];
    expect(optionLabel(o, t, lines, 2, { subset: true })).toBe("Charge 173.50 on Nov 14 → phone case, book");
    expect(optionLabel(o, t, lines, 2, { subset: true, payee: "Amazon" })).toBe("Amazon: charge 173.50 on Nov 14 → phone case, book");
  });
  it("unknown txn", () => expect(optionLabel(o, undefined, [], 2, { subset: false })).toBe("Transaction t"));
  it("helpers", () => {
    expect(fmtAmount(-5000, 0)).toBe("5");
    expect(fmtDate("not a date")).toBe("not a date");
    expect(txnPayee(txn({ id: "x", date: "2026-11-01", amount: 1, importPayeeOriginal: "ORIG" }))).toBe("ORIG");
    expect(txnPayee(txn({ id: "x", date: "2026-11-01", amount: 1 }))).toBe("Unknown payee");
  });
});

import { describe, expect, it } from "vitest";
import { syncErrorText } from "../../src/client/components/AppShell";
import { describeSync } from "../../src/client/hooks/useSync";
import { highConfidenceItems } from "../../src/client/routes/inbox";
import { extractUserId, parseLoginSearch } from "../../src/client/lib/routing";
import type { InboxItem, SyncResult } from "../../src/shared/schemas";

describe("login search", () => {
  it("parses pat, error, uid and a safe redirect", () => {
    expect(parseLoginSearch({ pat: "1", error: "not_allowed", uid: "u-1", redirect: "/inbox" }))
      .toEqual({ pat: true, error: "not_allowed", uid: "u-1", redirect: "/inbox" });
    expect(parseLoginSearch({ pat: 1 })).toEqual({ pat: true });
  });
  it("drops absolute or protocol-relative redirects", () => {
    expect(parseLoginSearch({ redirect: "https://evil.example" })).toEqual({});
    expect(parseLoginSearch({ redirect: "//evil.example" })).toEqual({});
  });
  it("extracts the user id from a not_allowed message", () => {
    expect(extractUserId("This app is private. Send your user id 8f2c1d9e-aa to the owner.")).toBe("8f2c1d9e-aa");
    expect(extractUserId("nope")).toBeUndefined();
  });
});

describe("sync copy", () => {
  const r = (p: Partial<SyncResult>): SyncResult => ({
    ranAt: 1, skipped: null, changedTransactions: 0, matched: 0, reviewsCreated: 0, stale: 0, inboxSuggested: 0, errors: [], ...p,
  });
  it("describes results", () => {
    expect(describeSync(r({ skipped: "throttled" })).kind).toBe("info");
    expect(describeSync(r({ matched: 2 })).text).toBe("Synced · 2 matched");
    expect(describeSync(r({ skipped: "error", errors: [{ code: "ynab_subscription_lapsed", message: "lapsed" }] })).kind).toBe("error");
  });
  it("maps stored sync errors to banner text", () => {
    expect(syncErrorText("ynab_subscription_lapsed: 403.1")).toBe("Sync failing: YNAB subscription lapsed");
    expect(syncErrorText("anthropic_billing: low")).toBe("Anthropic: credit balance too low");
    expect(syncErrorText("weird: thing broke")).toBe("Sync failing: thing broke");
  });
});

describe("inbox bulk approve", () => {
  const item = (id: string, s: InboxItem["suggestion"], pi: InboxItem["possibleIntent"] = null): InboxItem => ({
    transaction: {
      id, date: "2026-11-16", amount: -1000, payeeName: null, importPayeeName: "X", accountId: "a", accountName: "A",
      categoryId: null, memo: null, approved: false, cleared: "cleared", isSplit: false, isTransfer: false, isImported: true,
    },
    suggestion: s,
    possibleIntent: pi,
  });
  it("only takes high-confidence suggestions with a category and no possible intent", () => {
    const items = [
      item("1", { categoryId: "c", confidence: "high", reason: "", source: "claude" }),
      item("2", { categoryId: "c", confidence: "medium", reason: "", source: "claude" }),
      item("3", { categoryId: null, confidence: "high", reason: "", source: "claude" }),
      item("4", { categoryId: "c", confidence: "high", reason: "", source: "history" }, { intentId: "i", payee: "P", totalAmount: 1, date: "2026-11-16" }),
      item("5", null),
    ];
    expect(highConfidenceItems(items)).toEqual([{ transactionId: "1", categoryId: "c" }]);
  });
});

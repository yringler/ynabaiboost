import { describe, expect, it } from "vitest";
import { syncErrorText } from "../../src/client/components/AppShell";
import { describeSync } from "../../src/client/hooks/useSync";
import { extractUserId, parseLoginSearch } from "../../src/client/lib/routing";
import type { SyncResult } from "../../src/shared/schemas";

describe("login search", () => {
  it("parses pat, error, uid and a safe redirect", () => {
    expect(parseLoginSearch({ pat: "1", error: "not_allowed", uid: "u-1", redirect: "/pending" }))
      .toEqual({ pat: true, error: "not_allowed", uid: "u-1", redirect: "/pending" });
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
    ranAt: 1, skipped: null, changedTransactions: 0, matched: 0, reviewsCreated: 0, stale: 0, errors: [], ...p,
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

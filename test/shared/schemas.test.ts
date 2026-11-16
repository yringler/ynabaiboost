import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, IntentCreate, resolveSettings, SettingsPatch } from "../../src/shared/schemas";

describe("resolveSettings", () => {
  it("returns defaults for garbage", () => {
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings("x")).toEqual(DEFAULT_SETTINGS);
  });
  it("keeps valid stored fields and drops invalid or unknown ones", () => {
    const s = resolveSettings({
      timezone: "Europe/Berlin",
      staleAfterDays: 1000, // invalid (max 90)
      flagColor: "pink", // invalid
      maxTaxRate: 0.08,
      removedField: true, // unknown
      planId: "plan-1",
    });
    expect(s.timezone).toBe("Europe/Berlin");
    expect(s.staleAfterDays).toBe(DEFAULT_SETTINGS.staleAfterDays);
    expect(s.flagColor).toBe(DEFAULT_SETTINGS.flagColor);
    expect(s.maxTaxRate).toBe(0.08);
    expect(s.planId).toBe("plan-1");
    expect("removedField" in s).toBe(false);
  });
  it("SettingsPatch is strict", () => {
    expect(SettingsPatch.safeParse({ timezone: "UTC" }).success).toBe(true);
    expect(SettingsPatch.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("IntentCreate", () => {
  const base = {
    payee: "Costco", payeeId: null, merchantKind: "in_person", direction: "outflow", date: "2026-11-16",
    accountId: null, accountExplicit: false, totalAmount: 200000, approximate: true, memo: null,
    createPlaceholder: true,
    lines: [{ description: "groceries", categoryId: "c1", amount: 200000, approximate: true, confidence: null }],
  };
  it("accepts a confirmed single-line draft", () => {
    expect(IntentCreate.safeParse(base).success).toBe(true);
  });
  it("accepts a single line without an amount", () => {
    expect(IntentCreate.safeParse({ ...base, lines: [{ ...base.lines[0], amount: null }] }).success).toBe(true);
  });
  it("requires a positive total", () => {
    expect(IntentCreate.safeParse({ ...base, totalAmount: 0 }).success).toBe(false);
    expect(IntentCreate.safeParse({ ...base, totalAmount: null }).success).toBe(false);
  });
  it("requires a category on every line", () => {
    expect(IntentCreate.safeParse({ ...base, lines: [{ ...base.lines[0], categoryId: null }] }).success).toBe(false);
  });
  it("requires every line amount when there are several lines", () => {
    const two = [
      { description: "a", categoryId: "c1", amount: 100000, approximate: false, confidence: null },
      { description: "b", categoryId: "c2", amount: null, approximate: false, confidence: null },
    ];
    const r = IntentCreate.safeParse({ ...base, lines: two });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["lines"]);
    const ok = IntentCreate.safeParse({ ...base, lines: [two[0], { ...two[1], amount: 100000 }] });
    expect(ok.success).toBe(true);
  });
  it("rejects bad dates and non-integer milliunits", () => {
    expect(IntentCreate.safeParse({ ...base, date: "2026-13-01" }).success).toBe(false);
    expect(IntentCreate.safeParse({ ...base, totalAmount: 1.5 }).success).toBe(false);
  });
});

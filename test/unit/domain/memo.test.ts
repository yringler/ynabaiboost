import { describe, expect, it } from "vitest";
import { hasTag, MEMO_MAX, memoTag, mergeMemo, stripApprox, tagsIn } from "../../../src/worker/domain/memo";

const TAG = memoTag("K3F9QX");

describe("memo tags (§10.8)", () => {
  it("format", () => expect(TAG).toBe("[aib:K3F9QX]"));
  it("hasTag", () => {
    expect(hasTag("phone case [aib:K3F9QX]", "K3F9QX")).toBe(true);
    expect(hasTag("phone case [aib:K3F9QY]", "K3F9QX")).toBe(false);
    expect(hasTag(null, "K3F9QX")).toBe(false);
  });
  it("tagsIn finds every tag once", () => {
    expect(tagsIn("a [aib:AAAAAA] b [aib:BBBBBB] [aib:AAAAAA]")).toEqual(["AAAAAA", "BBBBBB"]);
    expect(tagsIn(null)).toEqual([]);
  });
});

describe("mergeMemo (§10.8)", () => {
  it("placeholder memo", () => expect(mergeMemo(null, "≈ phone case, book", TAG)).toBe("≈ phone case, book [aib:K3F9QX]"));
  it("appends to an existing memo with ' | '", () => expect(mergeMemo("gift for mum", "book", TAG)).toBe("gift for mum | book [aib:K3F9QX]"));
  it("no addition → tag only", () => {
    expect(mergeMemo(null, null, TAG)).toBe(TAG);
    expect(mergeMemo("x", "", TAG)).toBe(`x | ${TAG}`);
  });
  it("idempotent when the tag is present", () => {
    const once = mergeMemo("gift", "book", TAG);
    expect(mergeMemo(once, "book", TAG)).toBe(once);
    expect(mergeMemo(`  ${once}  `, "other", TAG)).toBe(once);
  });
  it("truncates the addition, never the user's text or the tag", () => {
    const base = "u".repeat(400);
    const m = mergeMemo(base, "a".repeat(300), TAG);
    expect(m.length).toBeLessThanOrEqual(MEMO_MAX);
    expect(m.startsWith(base)).toBe(true);
    expect(m.endsWith(TAG)).toBe(true);
    expect(m).toContain("…");
  });
  it("with no room for the addition keeps base + tag", () => {
    const base = "u".repeat(MEMO_MAX - 3 - TAG.length);
    expect(mergeMemo(base, "addition", TAG)).toBe(`${base} | ${TAG}`);
  });
  it("degenerate: a 500-char user memo is shortened only enough to fit the tag", () => {
    const m = mergeMemo("u".repeat(MEMO_MAX), "x", TAG);
    expect(m.length).toBeLessThanOrEqual(MEMO_MAX);
    expect(m.endsWith(TAG)).toBe(true);
  });
  it("stripApprox removes the ≈ prefix only", () => {
    expect(stripApprox("≈ phone case [aib:K3F9QX]")).toBe("phone case [aib:K3F9QX]");
    expect(stripApprox("≈phone")).toBe("phone");
    expect(stripApprox("phone ≈ 2")).toBe("phone ≈ 2");
    expect(stripApprox(null)).toBeNull();
  });
});

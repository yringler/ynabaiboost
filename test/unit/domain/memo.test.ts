import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_MAX, attribution, did, hasTag, MEMO_MAX, memoTag, mergeMemo, stripApprox, stripAttribution, tagsIn,
} from "../../../src/worker/domain/memo";

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

describe("human-readable attribution (§10.8)", () => {
  const USD = { isoCode: "USD", decimalDigits: 2 };
  const MATCHED = did.matched("2026-11-14", false, 1);

  it("texts per write type", () => {
    expect(did.placeholder(200000, true, USD)).toBe("placeholder for ≈$200.00 note");
    expect(did.placeholder(47230, false, USD)).toBe("placeholder for $47.23 note");
    expect(did.remaining(50000, true, USD)).toBe("placeholder for remaining ≈$50.00");
    expect(did.recorded("2026-11-14")).toBe("recorded note from Nov 14");
    expect(MATCHED).toBe("matched note from Nov 14");
    expect(did.matched("2026-11-14", true, 1)).toBe("matched Amazon order from Nov 14");
    expect(did.matched("2026-11-14", true, 3)).toBe("split across 3 categories from Amazon order of Nov 14");
    expect(did.needsSplit("2026-11-14", false)).toBe("linked to note from Nov 14, split it in YNAB");
    expect(did.kept()).toBe("kept as final");
    expect(did.edited("2026-11-16", true)).toBe("edited by voice/text (Nov 16)");
    expect(did.edited("2026-11-16", false)).toBe("edited in the app (Nov 16)");
  });

  it("sits just before the tag; the user's memo stays first", () => {
    expect(mergeMemo(null, "phone case", TAG, MATCHED)).toBe("phone case · AI Boost: matched note from Nov 14 [aib:K3F9QX]");
    expect(mergeMemo("gift for mum", "book", TAG, MATCHED)).toBe("gift for mum | book · AI Boost: matched note from Nov 14 [aib:K3F9QX]");
    expect(mergeMemo(null, null, TAG, "kept as final")).toBe("AI Boost: kept as final [aib:K3F9QX]");
  });

  it("idempotent: re-applying replaces our attribution, never stacks, never touches user text", () => {
    const once = mergeMemo("gift", "book", TAG, MATCHED);
    expect(mergeMemo(once, "book", TAG, MATCHED)).toBe(once);
    const kept = mergeMemo(once, "book", TAG, "kept as final");
    expect(kept).toBe("gift | book · AI Boost: kept as final [aib:K3F9QX]");
    expect(kept.match(/AI Boost:/g)).toHaveLength(1);
    // user text added after our write (in front, or after the tag) is preserved
    const edited = mergeMemo(`mine | ${once} more of mine`, null, TAG, "kept as final");
    expect(edited).toBe("mine | gift | book · AI Boost: kept as final [aib:K3F9QX] more of mine");
    // without an attribution, a tagged memo is returned as it is (crash-replay "finalize" never writes)
    expect(mergeMemo(once, "book", TAG)).toBe(once);
  });

  it("an old-format memo gets the attribution inserted before the tag", () => {
    expect(mergeMemo("≈ phone case [aib:K3F9QX]", null, TAG, "kept as final")).toBe("≈ phone case · AI Boost: kept as final [aib:K3F9QX]");
    expect(mergeMemo("note | [aib:K3F9QX]", null, TAG, "kept as final")).toBe("note | AI Boost: kept as final [aib:K3F9QX]");
    expect(mergeMemo("[aib:K3F9QX]", null, TAG, "kept as final")).toBe("AI Boost: kept as final [aib:K3F9QX]");
  });

  it("only the attribution in front of this tag is replaced", () => {
    const other = memoTag("AAAAAA");
    const two = `${mergeMemo(null, "a", other, MATCHED)} | ${mergeMemo(null, "b", TAG, MATCHED)}`;
    expect(mergeMemo(two, null, TAG, "kept as final"))
      .toBe("a · AI Boost: matched note from Nov 14 [aib:AAAAAA] | b · AI Boost: kept as final [aib:K3F9QX]");
  });

  it("stripAttribution: old and new format compare equal", () => {
    const old = mergeMemo(null, "≈ groceries", TAG);
    const neu = mergeMemo(null, "≈ groceries", TAG, did.placeholder(200000, true, USD));
    expect(neu).not.toBe(old);
    expect(stripAttribution(neu)).toBe(old);
    expect(stripAttribution(old)).toBe(old);
    expect(stripAttribution(mergeMemo(null, null, TAG, "kept as final"))).toBe(TAG);
    expect(stripAttribution("me | x · AI Boost: y [aib:K3F9QX]")).toBe("me | x [aib:K3F9QX]");
    expect(stripAttribution(null)).toBe("");
  });

  it("can never be mistaken for a tag", () => {
    const a = attribution("fake [aib:ZZZZZZ] | trick");
    expect(a).toBe("AI Boost: fake aib:ZZZZZZ trick");
    expect(tagsIn(a)).toEqual([]);
    const m = mergeMemo(null, "x", TAG, "[aib:ZZZZZZ]");
    expect(tagsIn(m)).toEqual(["K3F9QX"]);
    expect(hasTag(m, "K3F9QX")).toBe(true);
    expect(attribution("y".repeat(200)).length).toBeLessThanOrEqual("AI Boost: ".length + ATTRIBUTION_MAX);
  });

  it("truncation cuts the descriptions first, then drops the attribution, never the tag or the user's text", () => {
    const base = "u".repeat(400);
    const m = mergeMemo(base, "a".repeat(300), TAG, MATCHED);
    expect(m.length).toBeLessThanOrEqual(MEMO_MAX);
    expect(m.startsWith(`${base} | `)).toBe(true);
    expect(m.endsWith(` · AI Boost: matched note from Nov 14 ${TAG}`)).toBe(true);
    expect(m).toContain("…");

    const tight = "u".repeat(MEMO_MAX - 3 - TAG.length - 5); // room for the tag, not for the attribution
    expect(mergeMemo(tight, "book", TAG, MATCHED)).toBe(`${tight} | book ${TAG}`);
    const full = "u".repeat(MEMO_MAX);
    const d = mergeMemo(full, "x", TAG, MATCHED);
    expect(d.length).toBeLessThanOrEqual(MEMO_MAX);
    expect(d.endsWith(` | ${TAG}`)).toBe(true);
    expect(d).not.toContain("AI Boost");

    // replacing an attribution on a nearly full memo: removed rather than overflowing, tag intact
    const near = `${"u".repeat(MEMO_MAX - TAG.length - 12)} · AI Boost: x ${TAG}`.slice(-MEMO_MAX);
    const r = mergeMemo(near, null, TAG, "a much longer attribution text here");
    expect(r.length).toBeLessThanOrEqual(MEMO_MAX);
    expect(r.endsWith(TAG)).toBe(true);
    expect(r.match(/AI Boost:/g) ?? []).toHaveLength(0);
  });
});

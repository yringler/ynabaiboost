import { describe, expect, it } from "vitest";
import { API, ERROR_STATUS, ErrorCode } from "../../src/shared/api";

describe("API route table", () => {
  it("has unique method+path pairs", () => {
    const seen = new Set<string>();
    for (const r of Object.values(API)) {
      const k = `${r.method} ${r.path}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
  });
  it("keeps every path under /api or /auth", () => {
    for (const r of Object.values(API)) expect(r.path).toMatch(/^\/(api|auth)\//);
  });
  it("maps every ErrorCode to an HTTP status", () => {
    for (const code of ErrorCode.options) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
  it("types query schemas only where declared", () => {
    expect(API.listIntents.query?.parse({})).toEqual({ status: "open" });
    expect(API.activity.query?.parse({ before: "123" })).toEqual({ before: 123 });
    expect(API.me.query).toBeNull();
  });
});

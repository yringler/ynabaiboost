import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, buildPath, call, codeForStatus, errorMessage, postAudio } from "../../src/client/lib/api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(res: Response | (() => Promise<Response>)) {
  const fn = vi.fn<typeof fetch>(async () => (typeof res === "function" ? res() : res));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("buildPath", () => {
  it("substitutes and encodes params", () => {
    expect(buildPath("/api/intents/:id/link", { id: "a b/c" })).toBe("/api/intents/a%20b%2Fc/link");
  });
  it("throws on a missing param", () => {
    expect(() => buildPath("/api/intents/:id", {})).toThrow(/missing path param/);
  });
  it("appends defined query values only", () => {
    expect(buildPath("/api/activity", undefined, { before: 123, x: undefined })).toBe("/api/activity?before=123");
    expect(buildPath("/api/activity", undefined, {})).toBe("/api/activity");
  });
});

describe("call", () => {
  it("GETs without a body or Content-Type and parses the response", async () => {
    const f = mockFetch(json({ oauthAvailable: true }));
    await expect(call("authConfig")).resolves.toEqual({ oauthAvailable: true });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("/auth/config");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init?.credentials).toBe("same-origin");
  });

  it("sends JSON with Content-Type for a body, and substitutes params", async () => {
    const f = mockFetch(json({ ok: true }));
    await call("resolveReview", { params: { id: "r1" }, body: { optionId: "o2" } });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("/api/reviews/r1/resolve");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ optionId: "o2" }));
  });

  it("passes typed query params", async () => {
    const f = mockFetch(json({ intents: [] }));
    await call("listIntents", { query: { status: "stale" } });
    expect(f.mock.calls[0]?.[0]).toBe("/api/intents?status=stale");
  });

  it("maps an ApiErrorBody to ApiError with its code", async () => {
    mockFetch(json({ error: { code: "not_allowed", message: "Send your user id abc-123 to the owner" } }, 403));
    const err = await call("me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: "not_allowed", message: "Send your user id abc-123 to the owner" });
  });

  it("falls back to a status-derived code for non-ApiErrorBody errors", async () => {
    mockFetch(new Response("<html>bad gateway</html>", { status: 401, statusText: "Unauthorized" }));
    await expect(call("me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("turns network failures into ApiError(0, internal)", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(call("me")).rejects.toMatchObject({ status: 0, code: "internal" });
  });

  it("rethrows aborts untouched", async () => {
    mockFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await expect(call("me")).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("postAudio", () => {
  it("posts the raw blob with its own content type", async () => {
    const f = mockFetch(json({ text: "hello" }));
    const blob = new Blob(["abc"], { type: "audio/webm" });
    await expect(postAudio(blob)).resolves.toEqual({ text: "hello" });
    const init = f.mock.calls[0]?.[1];
    expect(f.mock.calls[0]?.[0]).toBe("/api/stt");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("audio/webm");
    expect(init?.body).toBe(blob);
  });
  it("surfaces stt_not_allowed", async () => {
    mockFetch(json({ error: { code: "stt_not_allowed", message: "no" } }, 403));
    await expect(postAudio(new Blob(["x"], { type: "audio/mp4" }))).rejects.toMatchObject({ code: "stt_not_allowed" });
  });
});

describe("error helpers", () => {
  it("codeForStatus", () => {
    expect(codeForStatus(413)).toBe("payload_too_large");
    expect(codeForStatus(502)).toBe("internal");
  });
  it("errorMessage has friendly copy for actionable codes", () => {
    expect(errorMessage(new ApiError(409, "anthropic_billing", "x"))).toMatch(/credit balance/);
    expect(errorMessage(new ApiError(500, "internal", "boom"))).toBe("boom");
    expect(errorMessage(new Error("plain"))).toBe("plain");
  });
});

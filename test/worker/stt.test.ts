// WP4: server STT (§11.3) with the Workers AI binding stubbed (no Cloudflare credentials in tests).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../../src/worker/auth/settings";
import { NOVA3_MODEL, toBase64, transcribe, vocabularyPrompt, WHISPER_MODEL } from "../../src/worker/ai/stt";
import { app } from "../../src/worker/index";
import { AppError } from "../../src/worker/lib/errors";
import { ynabCategories, ynabCategoryGroups, ynabPayees } from "../../src/worker/db/schema";
import { db, envWith, ORIGIN, seedSession, seedUser, uid } from "./wp2-helpers";

type Run = (model: string, input: Record<string, unknown>) => Promise<unknown>;
const withAI = (run: Run, over: Partial<Env> = {}): Env => envWith({ ALLOWED_USER_IDS: "*", ...over, AI: { run } as unknown as Ai });

const audio = (n = 2048) => new Uint8Array(n).map((_, i) => i % 251).buffer;
const hints = { payees: ["Costco", "Trader Joe's"], categories: ["Groceries"] };

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("transcribe", () => {
  it("whisper: raw base64 audio, VAD, no conditioning, vocabulary prompt; returns trimmed text", async () => {
    const run = vi.fn<Run>(async () => ({ text: "  Costco about 200 dollars  " }));
    const bytes = audio(70_000);
    await expect(transcribe(withAI(run, { STT_MODEL: "whisper" }), bytes, "audio/webm", hints)).resolves.toBe("Costco about 200 dollars");
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input] = run.mock.calls[0]!;
    expect(model).toBe(WHISPER_MODEL);
    expect(input).toEqual({
      audio: toBase64(bytes), vad_filter: true, condition_on_previous_text: false,
      initial_prompt: "Payees: Costco, Trader Joe's. Categories: Groceries.",
    });
    expect(String(input.audio)).not.toMatch(/^data:/);
  });

  it("toBase64 matches btoa over the whole buffer (chunked encoding)", () => {
    const bytes = audio(100_000);
    let bin = "";
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    expect(toBase64(bytes)).toBe(btoa(bin));
    expect(toBase64(new ArrayBuffer(0))).toBe("");
  });

  it("nova3: audio body + contentType, smart_format, numerals; reads the first alternative", async () => {
    const run = vi.fn<Run>(async () => ({ results: { channels: [{ alternatives: [{ transcript: "Target 42.17" }] }] } }));
    await expect(transcribe(withAI(run, { STT_MODEL: "nova3" }), audio(), "audio/mp4", hints)).resolves.toBe("Target 42.17");
    const [model, input] = run.mock.calls[0]!;
    expect(model).toBe(NOVA3_MODEL);
    expect(input).toMatchObject({ smart_format: true, numerals: true, audio: { contentType: "audio/mp4" } });
    expect((input.audio as { body: unknown }).body).toBeInstanceOf(ReadableStream);
  });

  it("capacity error 3040 is retried once", async () => {
    const run = vi.fn<Run>()
      .mockRejectedValueOnce(new Error("3040: Capacity temporarily exceeded, please try again."))
      .mockResolvedValueOnce({ text: "ok" });
    await expect(transcribe(withAI(run), audio(), "audio/webm", hints)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("3040 twice, or any other error → ai_unavailable", async () => {
    const capacity = vi.fn<Run>(async () => { throw new Error("3040: Capacity temporarily exceeded"); });
    await expect(transcribe(withAI(capacity), audio(), "audio/webm", hints)).rejects.toMatchObject({ code: "ai_unavailable" });
    expect(capacity).toHaveBeenCalledTimes(2);
    const other = vi.fn<Run>(async () => { throw new Error("5006: invalid audio"); });
    const e = await transcribe(withAI(other), audio(), "audio/webm", hints).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("vocabulary prompt keeps at most 30 names each and collapses whitespace", () => {
    const many = Array.from({ length: 40 }, (_, i) => `P${i}`);
    const p = vocabularyPrompt({ payees: [...many, " a \n b "], categories: [] });
    expect(p).toContain("P29");
    expect(p).not.toContain("P30");
    expect(vocabularyPrompt({ payees: ["  x\ny "], categories: [""] })).toBe("Payees: x y. Categories: .");
  });
});

describe("POST /api/stt", () => {
  let user = "";
  let cookie = "";
  beforeEach(async () => {
    user = uid("stt");
    await seedUser(user, { sttAllowed: true });
    cookie = (await seedSession(user)).cookie;
  });

  const post = (e: Env, body: BodyInit | null, contentType: string, extra: Record<string, string> = {}) =>
    app.request(`${ORIGIN}/api/stt`, {
      method: "POST", body, headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin", "Content-Type": contentType, ...extra },
    }, e);

  it("transcribes an allowed audio type with hints from the cache", async () => {
    await updateSettings(db(), user, { planId: "plan-stt", timezone: "UTC" });
    await db().insert(ynabPayees).values({ userId: user, planId: "plan-stt", id: "p1", name: "Costco", transferAccountId: null, deleted: false });
    await db().insert(ynabCategoryGroups).values({ userId: user, planId: "plan-stt", id: "g1", name: "Everyday", hidden: false, deleted: false });
    await db().insert(ynabCategories).values({ userId: user, planId: "plan-stt", id: "c1", groupId: "g1", name: "Groceries", hidden: false, deleted: false, sortIndex: 0 });
    const run = vi.fn<Run>(async () => ({ text: "costco 200" }));
    const res = await post(withAI(run), audio(), "audio/webm;codecs=opus");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "costco 200" });
    expect(run.mock.calls[0]?.[1]).toMatchObject({ initial_prompt: "Payees: Costco. Categories: Groceries." });
  });

  it("403 stt_not_allowed unless the admin enabled STT", async () => {
    const other = uid("stt-no");
    await seedUser(other, { sttAllowed: false });
    cookie = (await seedSession(other)).cookie;
    const run = vi.fn<Run>();
    const res = await post(withAI(run), audio(), "audio/webm");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "stt_not_allowed" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("415 for types outside the allowlist", async () => {
    for (const ct of ["video/webm", "application/json", "audio/flac", ""]) {
      const res = await post(withAI(vi.fn<Run>()), audio(), ct);
      expect(res.status, ct).toBe(415);
      expect(await res.json()).toMatchObject({ error: { code: "unsupported_media" } });
    }
  });

  it("all allowlisted types are accepted", async () => {
    for (const ct of ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav", "AUDIO/MP4; codecs=mp4a.40.2"]) {
      const res = await post(withAI(vi.fn<Run>(async () => ({ text: "x" }))), audio(), ct);
      expect(res.status, ct).toBe(200);
    }
  });

  it("413 above 2 MB", async () => {
    const run = vi.fn<Run>();
    const res = await post(withAI(run), new Uint8Array(2 * 1024 * 1024 + 1), "audio/webm");
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("400 for an empty body; 503 when the model fails", async () => {
    let res = await post(withAI(vi.fn<Run>()), new Uint8Array(0), "audio/webm");
    expect(res.status).toBe(400);
    res = await post(withAI(vi.fn<Run>(async () => { throw new Error("boom"); })), audio(), "audio/webm");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "ai_unavailable" } });
  });

  it("cross-site POST is refused before reaching the model", async () => {
    const run = vi.fn<Run>();
    const res = await post(withAI(run), audio(), "audio/webm", { "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
});

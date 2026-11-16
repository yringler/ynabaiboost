// WP4: callStructured request shape and the §9.4 error policy, against canned API responses (msw handlers).
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { answerText, callStructured, CLAUDE_MODEL, FALLBACK_BETA } from "../../../src/worker/ai/claude";
import { AppError } from "../../../src/worker/lib/errors";
import { apiError, FakeAnthropic, messageBody, rawText, refusal, structured, truncated } from "../../msw/anthropic";

const Schema = z.object({ answer: z.string(), n: z.number().nullable() });
let fake: FakeAnthropic;
let client: Anthropic;

const args = (over: Partial<Parameters<typeof callStructured>[1]> = {}) => ({
  schema: Schema,
  system: [{ type: "text" as const, text: "SYSTEM" }, { type: "text" as const, text: "CATALOG", cache_control: { type: "ephemeral" as const } }],
  user: "TODAY: 2026-11-16",
  effort: "low" as const, maxTokens: 8000, timeoutMs: 30_000, maxRetries: 1,
  ...over,
});

async function expectCode(p: Promise<unknown>, code: string): Promise<AppError> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  return e as AppError;
}

beforeEach(() => {
  fake = new FakeAnthropic();
  client = new Anthropic({ apiKey: "sk-ant-test", fetch: fake.fetch, maxRetries: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("callStructured request", () => {
  it("sends model, effort, JSON-schema format, server-side fallback, and no thinking/tool_choice/tools", async () => {
    fake.reply(structured({ answer: "hi", n: 3 }));
    await expect(callStructured(client, args())).resolves.toEqual({ answer: "hi", n: 3 });
    expect(fake.requests).toHaveLength(1);
    const { body, headers } = fake.requests[0]!;
    expect(body.model).toBe(CLAUDE_MODEL);
    expect(body.max_tokens).toBe(8000);
    expect(body.output_config?.effort).toBe("low");
    expect(body.output_config?.format?.type).toBe("json_schema");
    expect(body.output_config?.format?.schema).toMatchObject({ type: "object", additionalProperties: false, required: ["answer", "n"] });
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain(FALLBACK_BETA);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("betas");          // goes in the header, not the body
    expect(body.system).toEqual(args().system);
    expect(body.messages).toEqual([{ role: "user", content: "TODAY: 2026-11-16" }]);
  });

  it("uses the text after the last fallback block when a fallback model served the turn", async () => {
    fake.reply({
      kind: "message",
      body: messageBody([
        { type: "text", text: '{"answer":"par', citations: null },
        { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } },
        { type: "text", text: '{"answer":"rescued","n":null}', citations: null },
      ], "end_turn", { usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] } }),
    });
    await expect(callStructured(client, args())).resolves.toEqual({ answer: "rescued", n: null });
  });
});

describe("callStructured stop reasons", () => {
  it("refusal → ai_refusal with the explanation", async () => {
    fake.reply(refusal("Not something I can help with"));
    const e = await expectCode(callStructured(client, args()), "ai_refusal");
    expect(e.message).toBe("Not something I can help with");
    expect(e.status).toBe(422);
  });

  it("refusal without details still maps to ai_refusal", async () => {
    fake.reply(refusal(null));
    await expectCode(callStructured(client, args()), "ai_refusal");
  });

  it("max_tokens → retries once with double max_tokens", async () => {
    fake.reply(truncated(), structured({ answer: "ok", n: 1 }));
    await expect(callStructured(client, args())).resolves.toEqual({ answer: "ok", n: 1 });
    expect(fake.requests.map((r) => r.body.max_tokens)).toEqual([8000, 16000]);
  });

  it("max_tokens twice → ai_unavailable", async () => {
    fake.reply(truncated(), truncated());
    await expectCode(callStructured(client, args()), "ai_unavailable");
    expect(fake.requests).toHaveLength(2);
  });

  it("output that does not match the schema (null parse) → ai_unavailable", async () => {
    fake.reply(rawText('{"answer": 42}'));
    await expectCode(callStructured(client, args()), "ai_unavailable");
  });

  it("no text at all → ai_unavailable", async () => {
    fake.reply({ kind: "message", body: messageBody([], "end_turn") });
    await expectCode(callStructured(client, args()), "ai_unavailable");
  });
});

describe("callStructured API errors (§9.4)", () => {
  it("401 → anthropic_key_invalid (no retry)", async () => {
    fake.reply(apiError(401, "authentication_error", "invalid x-api-key"));
    await expectCode(callStructured(client, args()), "anthropic_key_invalid");
    expect(fake.requests).toHaveLength(1);
  });

  it("403 → anthropic_key_invalid", async () => {
    fake.reply(apiError(403, "permission_error", "no access"));
    await expectCode(callStructured(client, args()), "anthropic_key_invalid");
  });

  it("429 twice → SDK retries once, then ai_unavailable", async () => {
    fake.reply(apiError(429, "rate_limit_error", "slow down"), apiError(429, "rate_limit_error", "slow down"));
    await expectCode(callStructured(client, args()), "ai_unavailable");
    expect(fake.requests).toHaveLength(2);
  });

  it("529 overloaded then success → the SDK retry succeeds", async () => {
    fake.reply(apiError(529, "overloaded_error", "Overloaded"), structured({ answer: "after retry", n: null }));
    await expect(callStructured(client, args())).resolves.toEqual({ answer: "after retry", n: null });
  });

  it("529 twice → ai_unavailable", async () => {
    fake.reply(apiError(529, "overloaded_error", "Overloaded"), apiError(529, "overloaded_error", "Overloaded"));
    await expectCode(callStructured(client, args()), "ai_unavailable");
  });

  it("billing 400 → anthropic_billing with the API message", async () => {
    const msg = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    fake.reply(apiError(400, "invalid_request_error", msg));
    const e = await expectCode(callStructured(client, args()), "anthropic_billing");
    expect(e.message).toBe(msg);
  });

  it("other 400 → internal (logged with the request id, not the body)", async () => {
    fake.reply(apiError(400, "invalid_request_error", "messages.0: bad"));
    await expectCode(callStructured(client, args()), "internal");
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("req_test_err");
    expect(logged).not.toContain("TODAY");
  });

  it("connection failure → ai_unavailable", async () => {
    const broken = new Anthropic({ apiKey: "sk-ant-test", maxRetries: 0, fetch: async () => { throw new TypeError("network down"); } });
    await expectCode(callStructured(broken, args({ maxRetries: 0 })), "ai_unavailable");
  });

  it("timeout → ai_unavailable", async () => {
    const slow = new Anthropic({
      apiKey: "sk-ant-test", maxRetries: 0,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    await expectCode(callStructured(slow, args({ timeoutMs: 20, maxRetries: 0 })), "ai_unavailable");
  });
});

describe("answerText", () => {
  it("joins text blocks and ignores thinking blocks", () => {
    expect(answerText({ content: [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "text", text: "{}", citations: null },
    ] as never })).toBe("{}");
  });
});

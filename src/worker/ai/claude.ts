// ai/claude.ts — WP4 (DESIGN §8.4, §9.1, §9.4).
// One structured-output call per task: no tools, no agent loop. Sonnet 5.5 rejects `thinking: {type:"disabled"}`,
// thinking budgets, non-default sampling params and a forced tool_choice, so we send adaptive thinking (omitted)
// with an explicit `output_config.effort` (the model defaults to "high"), and the JSON comes from
// `output_config.format` (zod → JSON schema via the SDK helper), validated again here.
//
// Server-side refusal fallback: requests carry the `server-side-fallback-2026-07-01` beta with
// `fallbacks: "default"`, so a policy decline is retried by the API on the model's default fallback inside the
// same call. A final `stop_reason: "refusal"` therefore means the whole chain declined → ai_refusal.
//
// The request is sent with `beta.messages.create` (not `.parse`) so stop_reason is checked BEFORE the text is
// parsed: `.parse` throws on the truncated JSON of a max_tokens or refusal stop, which would hide the reason.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { getAnthropicKey } from "../auth/anthropicKey";
import type { DB } from "../env";
import { AppError } from "../lib/errors";

export const CLAUDE_MODEL = "claude-sonnet-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Via getAnthropicKey (throws ai_consent_required / anthropic_key_missing). Timeouts/retries are per call. */
export async function getClaude(env: Env, db: DB, userId: string): Promise<Anthropic> {
  const apiKey = await getAnthropicKey(env, db, userId);
  return new Anthropic({ apiKey, maxRetries: 1 });
}

const BILLING = /credit balance|billing|purchase credits/i;

/** §9.4 error table for errors thrown by the SDK. */
export function mapClaudeError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AppError("anthropic_key_invalid", "Anthropic rejected the API key. Update it in Settings.", e);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    // includes APIConnectionTimeoutError (after the SDK's own retry)
    return new AppError("ai_unavailable", "Claude did not answer in time. Try again.", e);
  }
  if (e instanceof Anthropic.BadRequestError) {
    const message = e.apiMessage ?? e.message;
    if (BILLING.test(message)) return new AppError("anthropic_billing", message, e);
    logApiError("claude_bad_request", e);
    return new AppError("internal", "Claude rejected the request", e);
  }
  if (e instanceof Anthropic.APIError) {
    // RateLimitError (429), RequestTimeout (408), 5xx incl. 529 overloaded: the SDK already retried once.
    if (e.status === 408 || e.status === 429 || (typeof e.status === "number" && e.status >= 500)) {
      return new AppError("ai_unavailable", "Claude is busy right now. Try again in a minute.", e);
    }
    if (e.status === undefined) return new AppError("ai_unavailable", "The request to Claude was aborted", e); // APIUserAbortError
    logApiError("claude_api_error", e);
    return new AppError("internal", "Claude request failed", e);
  }
  if (e instanceof Anthropic.AnthropicError) {
    return new AppError("ai_unavailable", "Claude returned an unusable answer", e);
  }
  return e;
}

function logApiError(msg: string, e: InstanceType<typeof Anthropic.APIError>): void {
  // Never the request body or the key (§16): status, type and the request id only.
  console.error(JSON.stringify({ msg, status: e.status ?? null, type: e.type ?? null, requestId: e.requestID ?? null }));
}

/** Text of the answer that counts: blocks after the last `fallback` switch point (a declined model's partial
 *  output may precede it). Structured output arrives as one text block. */
export function answerText(res: Pick<BetaMessage, "content">): string {
  let start = 0;
  res.content.forEach((b, i) => {
    if (b.type === "fallback") start = i + 1;
  });
  return res.content
    .slice(start)
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");
}

/** messages.parse + zodOutputFormat semantics with the §9.4 error policy. */
export async function callStructured<T extends z.ZodType>(client: Anthropic, args: {
  schema: T; system: Anthropic.TextBlockParam[]; user: string;
  effort: "low" | "medium"; maxTokens: number; timeoutMs: number; maxRetries: number;
}): Promise<z.infer<T>> {
  const format = betaZodOutputFormat(args.schema);
  let maxTokens = args.maxTokens;
  for (let attempt = 0; ; attempt++) {
    let res: BetaMessage;
    try {
      res = await client.beta.messages.create(
        {
          model: CLAUDE_MODEL,
          max_tokens: maxTokens,                    // adaptive thinking counts here too (Sonnet 5.5)
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          output_config: { effort: args.effort, format: { type: "json_schema", schema: format.schema } },
          system: args.system,
          messages: [{ role: "user", content: args.user }],
        },
        { timeout: args.timeoutMs, maxRetries: args.maxRetries },
      );
    } catch (e) {
      throw mapClaudeError(e);
    }

    const fallbackRan = (res.usage.iterations ?? []).some((it) => it.type === "fallback_message");
    if (fallbackRan) console.info(JSON.stringify({ msg: "claude_fallback_served", model: res.model, stopReason: res.stop_reason }));

    if (res.stop_reason === "refusal") {
      throw new AppError("ai_refusal", res.stop_details?.explanation ?? "Claude declined to process this note");
    }
    if (res.stop_reason === "max_tokens") {
      if (attempt === 0) {
        maxTokens *= 2;
        continue;
      }
      throw new AppError("ai_unavailable", "Claude's answer was cut off. Try a shorter note.");
    }
    const text = answerText(res);
    if (text.trim() === "") throw new AppError("ai_unavailable", "Claude returned an empty answer");
    try {
      return format.parse(text) as z.infer<T>;
    } catch (e) {
      console.error(JSON.stringify({ msg: "claude_unparseable_output", model: res.model, stopReason: res.stop_reason }));
      throw new AppError("ai_unavailable", "Claude returned an unusable answer", e);
    }
  }
}

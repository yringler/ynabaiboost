// FakeAnthropic (WP4): canned api.anthropic.com /v1/messages replies for msw@3.
//   - Workers pool: network.use(...fake.handlers()) with @msw/cloudflare's setupNetwork().
//   - Node pool:    new Anthropic({ apiKey, fetch: fake.fetch }) — runs the same handlers via msw's getResponse,
//                   no global interception needed.
// Replies are consumed in order; every request is recorded (parsed JSON body + headers) for assertions.
import { getResponse, http, HttpResponse, type HttpHandler } from "msw";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export interface RecordedClaudeRequest {
  body: {
    model: string; max_tokens: number; system?: unknown; messages: { role: string; content: unknown }[];
    output_config?: { effort?: string; format?: { type: string; schema: unknown } };
    fallbacks?: unknown; thinking?: unknown; tool_choice?: unknown; tools?: unknown; betas?: unknown;
    [k: string]: unknown;
  };
  headers: Headers;
}

export type CannedReply =
  | { kind: "message"; body: Record<string, unknown> }
  | { kind: "error"; status: number; type: string; message: string; headers?: Record<string, string> };

let msgSeq = 0;

/** A Messages API response (beta shape) with the given content / stop reason. */
export function messageBody(content: unknown[], stopReason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `msg_test_${++msgSeq}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null },
    ...extra,
  };
}

/** A successful structured-output answer. */
export const structured = (value: unknown, extra: Record<string, unknown> = {}): CannedReply =>
  ({ kind: "message", body: messageBody([{ type: "text", text: JSON.stringify(value), citations: null }], "end_turn", extra) });

/** Raw text answer (e.g. JSON that does not match the schema). */
export const rawText = (text: string, stopReason = "end_turn"): CannedReply =>
  ({ kind: "message", body: messageBody([{ type: "text", text, citations: null }], stopReason) });

export const refusal = (explanation: string | null): CannedReply => ({
  kind: "message",
  body: messageBody([], "refusal", { stop_details: { type: "refusal", category: null, explanation } }),
});

/** max_tokens stop with truncated JSON. */
export const truncated = (): CannedReply => rawText('{"status":"ok","transactions":[{"payee":"Cos', "max_tokens");

export const apiError = (status: number, type: string, message: string): CannedReply =>
  // retry-after-ms: 0 keeps the SDK's single retry instant in tests.
  ({ kind: "error", status, type, message, headers: { "retry-after-ms": "0" } });

export class FakeAnthropic {
  requests: RecordedClaudeRequest[] = [];
  private queue: CannedReply[] = [];

  reply(...replies: CannedReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  handlers(): HttpHandler[] {
    return [
      http.post(ANTHROPIC_MESSAGES_URL, async ({ request }) => {
        const body = (await request.json()) as RecordedClaudeRequest["body"];
        this.requests.push({ body, headers: request.headers });
        const next = this.queue.shift();
        if (!next) {
          return HttpResponse.json(
            { type: "error", error: { type: "api_error", message: "FakeAnthropic: no reply queued" } },
            { status: 500, headers: { "request-id": "req_test_empty", "x-should-retry": "false" } },
          );
        }
        if (next.kind === "error") {
          return HttpResponse.json(
            { type: "error", error: { type: next.type, message: next.message } },
            { status: next.status, headers: { "request-id": "req_test_err", ...(next.headers ?? {}) } },
          );
        }
        return HttpResponse.json(next.body, { headers: { "request-id": "req_test_ok" } });
      }),
    ];
  }

  /** A fetch for `new Anthropic({ fetch })` that answers from these handlers (node tests). */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const res = await getResponse(this.handlers(), request);
    return res ?? new Response("FakeAnthropic: unhandled request", { status: 599 });
  };
}

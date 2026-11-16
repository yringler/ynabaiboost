// lib/api.ts — WP6 (DESIGN §11.1, D17): typed fetch helper driven by the shared route table.
// Always sends Content-Type: application/json with a body. Every non-2xx answer becomes an ApiError
// carrying the ApiErrorBody code (or a status-derived code when the body is not an ApiErrorBody).
import type { z } from "zod";
import { API, ApiErrorBody, ErrorCode, type ApiKey } from "../../shared/api";

type RouteOf<K extends ApiKey> = (typeof API)[K];
export type ReqOf<K extends ApiKey> = RouteOf<K>["req"] extends z.ZodType ? z.input<RouteOf<K>["req"]> : never;
export type QueryOf<K extends ApiKey> = RouteOf<K>["query"] extends z.ZodType ? z.input<RouteOf<K>["query"]> : never;
export type ResOf<K extends ApiKey> = z.output<RouteOf<K>["res"]>;

export interface CallOpts<K extends ApiKey> {
  params?: Record<string, string>;
  query?: QueryOf<K>;
  body?: ReqOf<K>;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Code used when the server's body is not an ApiErrorBody (proxy pages, network failures). */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400: return "validation";
    case 401: return "unauthenticated";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 413: return "payload_too_large";
    case 415: return "unsupported_media";
    case 429: return "rate_limited";
    default: return "internal";
  }
}

/** Substitutes `:param` segments (URL-encoded). Throws when a param is missing. */
export function buildPath(path: string, params?: Record<string, string>, query?: Record<string, unknown>): string {
  const filled = path.replace(/:([A-Za-z_]\w*)/g, (_m, name: string) => {
    const v = params?.[name];
    if (v === undefined) throw new Error(`missing path param "${name}" for ${path}`);
    return encodeURIComponent(v);
  });
  if (!query) return filled;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `${filled}?${s}` : filled;
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON (e.g. an HTML error page)
  }
  const parsed = ApiErrorBody.safeParse(body);
  if (parsed.success) return new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
  return new ApiError(res.status, codeForStatus(res.status), res.statusText || `HTTP ${res.status}`);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "internal", "Network error. Check your connection.");
  }
}

function parseResponse<K extends ApiKey>(key: K, data: unknown): ResOf<K> {
  const schema = API[key].res as z.ZodType;
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data as ResOf<K>;
  // Contract drift: surface loudly in development, stay usable in production.
  if (import.meta.env.DEV) console.warn(`[api] ${key}: response does not match the shared schema`, parsed.error);
  return data as ResOf<K>;
}

export async function call<K extends ApiKey>(key: K, opts: CallOpts<K> = {}): Promise<ResOf<K>> {
  const route = API[key];
  const url = buildPath(route.path, opts.params, opts.query as Record<string, unknown> | undefined);
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method: route.method, headers };
  if (opts.signal) init.signal = opts.signal;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await send(url, init);
  if (!res.ok) throw await toApiError(res);
  const data: unknown = await res.json().catch(() => null);
  return parseResponse(key, data);
}

/** POST /api/stt with a raw audio body (§11.3). */
export async function postAudio(blob: Blob, signal?: AbortSignal): Promise<ResOf<"stt">> {
  const init: RequestInit = {
    method: API.stt.method,
    headers: { "Content-Type": blob.type || "audio/webm", Accept: "application/json" },
    body: blob,
  };
  if (signal) init.signal = signal;
  const res = await send(API.stt.path, init);
  if (!res.ok) throw await toApiError(res);
  return parseResponse("stt", await res.json().catch(() => null));
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

/** Friendly message for an error, with special wording for the codes users can act on. */
export function errorMessage(e: unknown): string {
  if (!isApiError(e)) return e instanceof Error ? e.message : "Something went wrong";
  switch (e.code) {
    case "unauthenticated": return "Your session ended. Sign in again.";
    case "ynab_reauth_required": return "YNAB needs you to reconnect.";
    case "ynab_rate_limited": return "YNAB is rate limiting us. Try again in a few minutes.";
    case "ynab_subscription_lapsed": return "Your YNAB subscription has lapsed.";
    case "no_plan_selected": return "Pick a YNAB plan in Settings first.";
    case "anthropic_key_missing": return "Add your Anthropic API key in Settings.";
    case "anthropic_key_invalid": return "Your Anthropic API key was rejected.";
    case "anthropic_billing": return "Anthropic: credit balance too low.";
    case "ai_consent_required": return "Turn on AI data consent in Settings first.";
    case "ai_refusal": return "Claude couldn't read that. Try rephrasing or enter it manually.";
    case "ai_unavailable": return "Claude is unavailable right now. Try again or enter it manually.";
    case "rate_limited": return "Too many attempts. Wait a minute and try again.";
    default: return e.message || "Something went wrong";
  }
}

/** Codes that mean "the AI step failed, but the user can still type the intent by hand". */
export const AI_ERROR_CODES: readonly ErrorCode[] = [
  "ai_refusal", "ai_unavailable", "anthropic_billing", "anthropic_key_invalid", "anthropic_key_missing", "ai_consent_required",
];

// Re-export the zod enum so callers can validate codes without importing shared directly.
export { ErrorCode };

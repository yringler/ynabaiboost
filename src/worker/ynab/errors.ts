// ynab/errors.ts — WP3 (DESIGN §8.3, §12 WP3).
// YNAB answers errors as `{ error: { id, name, detail } }` where `id` is the HTTP status, optionally with a
// sub-code ("403.1" = subscription lapsed, "403.2" = trial expired, "404.2" = resource not found …).
import { AppError } from "../lib/errors";

export class YnabApiError extends Error {
  status: number;
  id: string;
  override name: string;
  detail: string;
  constructor(status: number, body: { id: string; name: string; detail: string }) {
    super(`YNAB ${status} ${body.id} ${body.name}: ${body.detail}`);
    this.status = status;
    this.id = body.id;
    this.name = body.name;
    this.detail = body.detail;
  }
}

export function isYnabErrorBody(x: unknown): x is { error: { id: string; name: string; detail: string } } {
  if (typeof x !== "object" || x === null || !("error" in x)) return false;
  const e = (x as { error: unknown }).error;
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.name === "string" && typeof r.detail === "string";
}

/** Status from a YNAB error id ("403.1" → 403); NaN-safe fallback 500. */
export function statusFromErrorId(id: string): number {
  const n = Number.parseInt(id, 10);
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : 500;
}

/** YnabApiError from anything the SDK or our fetch wrapper may throw, or null if it is not a YNAB HTTP error. */
export function asYnabApiError(e: unknown): YnabApiError | null {
  if (e instanceof YnabApiError) return e;
  // The SDK wraps exceptions thrown by `fetchApi` in a FetchError whose `cause` is our YnabApiError.
  if (e instanceof Error && e.cause instanceof YnabApiError) return e.cause;
  // The SDK itself throws the parsed JSON body on non-2xx (only reachable if our fetch wrapper is bypassed).
  if (isYnabErrorBody(e)) return new YnabApiError(statusFromErrorId(e.error.id), e.error);
  return null;
}

export const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;

/** 401 → ynab_reauth_required (+markNeedsReauth); 403.1/403.2 → ynab_subscription_lapsed;
 *  429 → ynab_rate_limited (+sync_state.rate_limited_until = now + 15 min); else ynab_error.
 *  Pure mapping: the side effects in parentheses are done by the client (ynab/client.ts), which has the DB. */
export function toAppError(e: YnabApiError): AppError {
  if (e.status === 401) {
    return new AppError("ynab_reauth_required", "YNAB authorization expired or was revoked. Please sign in again.", e);
  }
  if (e.status === 403 && (e.id === "403.1" || e.id === "403.2")) {
    return new AppError("ynab_subscription_lapsed", "Your YNAB subscription or trial has ended.", e);
  }
  if (e.status === 429) {
    return new AppError("ynab_rate_limited", "YNAB rate limit reached. Try again in a few minutes.", e);
  }
  const detail = e.detail ? `: ${e.detail}` : "";
  return new AppError("ynab_error", `YNAB error ${e.id}${detail}`.slice(0, 300), e);
}

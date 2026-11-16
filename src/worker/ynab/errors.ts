// ynab/errors.ts — WP3 (DESIGN §8.3). Stub created by WP1.
import type { AppError } from "../lib/errors";

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
export function isYnabErrorBody(_x: unknown): _x is { error: { id: string; name: string; detail: string } } {
  throw new Error("not implemented: isYnabErrorBody");
}
/** 401 → ynab_reauth_required (+markNeedsReauth); 403.1/403.2 → ynab_subscription_lapsed;
 *  429 → ynab_rate_limited (+sync_state.rate_limited_until = now + 15 min); else ynab_error. */
export function toAppError(_e: YnabApiError): AppError {
  throw new Error("not implemented: toAppError");
}

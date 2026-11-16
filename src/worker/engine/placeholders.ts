// engine/placeholders.ts — WP5 (DESIGN §8.5, §10.7). Stub created by WP1.
import type { EngineCtx } from "./reconcile";

/** Creates a placeholder, or a final entry when the account is not direct-import-linked (§10.7). */
export async function createPlaceholder(_ctx: EngineCtx, _intentId: string): Promise<{ ok: boolean; kind: "placeholder" | "final" | "none"; warning: string | null }> {
  throw new Error("not implemented: createPlaceholder");
}
/** Re-applies the D13 nudge. */
export async function updatePlaceholderAmount(_ctx: EngineCtx, _intentId: string, _remaining: number): Promise<void> {
  throw new Error("not implemented: updatePlaceholderAmount");
}
/** §10.7 guard. Returns "deleted", "gone" (404) or "refused" (+ ynab_matched_other review unless cancelling). */
export async function safeDeletePlaceholder(_ctx: EngineCtx, _intentId: string, _reason: "resolved" | "cancelled" | "stale_delete"): Promise<"deleted" | "gone" | "refused"> {
  throw new Error("not implemented: safeDeletePlaceholder");
}

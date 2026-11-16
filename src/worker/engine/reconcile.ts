// engine/reconcile.ts — WP5 (DESIGN §8.5, §10.9). Stub created by WP1.
import type { CurrencyFormat, Settings } from "../../shared/schemas";
import type { Actor, DB } from "../env";
import type { YnabClient } from "../ynab/client";
import type { SyncDelta } from "../ynab/sync";

export interface EngineCtx {
  env: Env; db: DB; client: YnabClient; userId: string; planId: string;
  settings: Settings; currency: CurrencyFormat; today: string; actor: Actor;
}
export interface ReconcileSummary { matched: number; reviewsCreated: number; stale: number; errors: string[] }
/** onlyIntentIds: plan decisions only for these intents (other intents' txns are still excluded). */
export async function reconcileUser(_ctx: EngineCtx, _delta: SyncDelta, _opts?: { onlyIntentIds?: string[] }): Promise<ReconcileSummary> {
  throw new Error("not implemented: reconcileUser");
}
export async function countOpen(_db: DB, _userId: string, _planId: string, _today: string): Promise<{ pending: number; stale: number; review: number }> {
  throw new Error("not implemented: countOpen");
}

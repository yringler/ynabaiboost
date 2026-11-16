// ynab/sync.ts — WP3 (DESIGN §8.3). Stub created by WP1.
import type { DB } from "../env";
import type { YnabClient } from "./client";

export interface SyncDelta { initial: boolean; changedTxnIds: string[]; deletedTxnIds: string[]; serverKnowledge: number }
/** Caller must hold the user lock (withUserLock). Upserts groups, categories, accounts, payees, then txns
 *  (txn payeeName resolved from the payee cache, see YnabTxn note). */
export async function syncPlan(_env: Env, _db: DB, _client: YnabClient, _userId: string, _planId: string): Promise<SyncDelta> {
  throw new Error("not implemented: syncPlan");
}

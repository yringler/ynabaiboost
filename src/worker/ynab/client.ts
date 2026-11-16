// ynab/client.ts — WP3 (DESIGN §8.3). Stub created by WP1.
import type { CurrencyFormat } from "../../shared/schemas";
import type { DB } from "../env";
import type {
  CachedAccount, CachedCategory, CachedCategoryGroup, CachedPayee, NewTxn, PlanDelta, TxnUpdate, YnabTxn,
} from "./types";

export interface YnabClient {
  getUserId(): Promise<string>;
  listPlans(): Promise<{ id: string; name: string }[]>;
  getPlanSettings(planId: string): Promise<CurrencyFormat>;
  getCategories(planId: string, k?: number): Promise<{ groups: CachedCategoryGroup[]; items: CachedCategory[]; serverKnowledge: number }>;
  getAccounts(planId: string, k?: number): Promise<{ items: CachedAccount[]; serverKnowledge: number }>;
  getPayees(planId: string, k?: number): Promise<{ items: CachedPayee[]; serverKnowledge: number }>;
  getTransactionsSince(planId: string, sinceDate: string, k?: number): Promise<{ items: YnabTxn[]; serverKnowledge: number }>;
  getPlanDelta(planId: string, k: number): Promise<PlanDelta>;
  getTransaction(planId: string, id: string): Promise<YnabTxn | null>;   // null on 404
  createTransaction(planId: string, txn: NewTxn): Promise<YnabTxn>;
  /** The only update method. Bulk PATCH /transactions; SaveTransactionWithIdOrImportId accepts
   *  `subtransactions`, so split conversion goes through here too. If spike S2 shows PATCH ignores
   *  subtransactions, the implementation sends split updates as individual PUTs internally;
   *  the signature does not change. Updating an existing split returns a YNAB error (SDK docs). */
  updateTransactions(planId: string, updates: TxnUpdate[]): Promise<YnabTxn[]>;
  deleteTransaction(planId: string, id: string): Promise<void>;          // 404 = success
}
export type RequestKind = "interactive" | "background";

/** Token via getYnabAccessToken. `kind` only changes backoff: interactive fails fast on 429. */
export async function createYnabClient(_env: Env, _db: DB, _userId: string, _kind: RequestKind): Promise<YnabClient> {
  throw new Error("not implemented: createYnabClient");
}
/** For login (no user row yet). */
export function createYnabClientForToken(_token: string): YnabClient {
  throw new Error("not implemented: createYnabClientForToken");
}

// ynab/cache.ts — WP3 (DESIGN §8.3). Stub created by WP1.
import type { Account, Category, CurrencyFormat, Payee, TxnView } from "../../shared/schemas";
import type { BatchItem, DB } from "../env";
import type { YnabTxn } from "./types";

export async function getCurrency(_db: DB, _userId: string, _planId: string): Promise<CurrencyFormat & { planName: string | null }> {
  throw new Error("not implemented: getCurrency");
}
/** JOIN groups; !deleted, !(c.hidden||g.hidden), !internal, !ccPayment; sorted */
export async function getSelectableCategories(_db: DB, _userId: string, _planId: string): Promise<Category[]> {
  throw new Error("not implemented: getSelectableCategories");
}
/** !deleted, !closed; includes directImportLinked */
export async function getAccounts(_db: DB, _userId: string, _planId: string): Promise<Account[]> {
  throw new Error("not implemented: getAccounts");
}
/** !deleted, non-transfer; for bestPayeeMatch */
export async function getAllPayees(_db: DB, _userId: string, _planId: string): Promise<Payee[]> {
  throw new Error("not implemented: getAllPayees");
}
export async function getTopPayees(_db: DB, _userId: string, _planId: string, _limit: number): Promise<Payee[]> {
  throw new Error("not implemented: getTopPayees");
}
export async function getRecentCategoryIds(_db: DB, _userId: string, _planId: string, _limit: number): Promise<string[]> {
  throw new Error("not implemented: getRecentCategoryIds");
}
export async function getCachedTxns(_db: DB, _userId: string, _planId: string, _q: { sinceDate?: string; ids?: string[]; includeDeleted?: boolean }): Promise<YnabTxn[]> {
  throw new Error("not implemented: getCachedTxns");
}
export function upsertTxnsStmts(_db: DB, _userId: string, _planId: string, _txns: YnabTxn[], _now?: number): BatchItem<"sqlite">[] {
  throw new Error("not implemented: upsertTxnsStmts");
}
export async function payeeCategoryHistory(_db: DB, _userId: string, _planId: string, _payeeIds: string[]): Promise<Map<string, { categoryId: string; count: number }[]>> {
  throw new Error("not implemented: payeeCategoryHistory");
}
/** shared/payee.ts payeeSimilarity ≥ 0.8 */
export async function lastAccountForPayee(_db: DB, _userId: string, _planId: string, _payee: string): Promise<string | null> {
  throw new Error("not implemented: lastAccountForPayee");
}
/** Category of the most recent matched (or approved, categorized) outflow at a similar payee (≥ 0.8). For inflow suggestions (§9.5). */
export async function lastOutflowCategoryForPayee(_db: DB, _userId: string, _planId: string, _payeeNames: (string | null)[]): Promise<string | null> {
  throw new Error("not implemented: lastOutflowCategoryForPayee");
}
/** null or internal "Uncategorized" */
export async function isUncategorized(_db: DB, _userId: string, _planId: string, _categoryId: string | null): Promise<boolean> {
  throw new Error("not implemented: isUncategorized");
}
export function toTxnView(_t: YnabTxn, _accountsById: Map<string, Account>, _uncategorizedIds: Set<string>): TxnView {
  throw new Error("not implemented: toTxnView");
}

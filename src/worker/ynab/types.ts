// ynab/types.ts — WP3 (DESIGN §8.3, frozen). Created by WP1.
import type { FlagColor } from "../../shared/schemas";

/** From GET /plans/{id} the SDK returns TransactionSummary + a separate `subtransactions` array:
 *  no payee_name / account_name / category_name. The converter MUST fill payeeName from the payee
 *  cache (merged with payees in the same delta) and set isSplit from the subtransactions array.
 *  Per-resource endpoints return TransactionDetail, which has payee_name; use it as is. */
export interface YnabTxn {
  id: string; planId: string; date: string; amount: number;
  payeeId: string | null; payeeName: string | null;
  importPayeeName: string | null; importPayeeNameOriginal: string | null;
  accountId: string; categoryId: string | null; memo: string | null;
  cleared: "cleared" | "uncleared" | "reconciled"; approved: boolean; flagColor: string | null;
  importId: string | null; matchedTransactionId: string | null; transferAccountId: string | null;
  isSplit: boolean; deleted: boolean;
}
export interface NewTxn {
  accountId: string; date: string; amount: number;               // signed
  payeeId: string | null; payeeName: string | null;              // one of them
  categoryId: string | null; memo: string | null;
  approved: boolean; flagColor: FlagColor | null;               // cleared is always 'uncleared'; never import_id
  subtransactions?: { amount: number; categoryId: string; memo: string | null }[]; // final entries only; implies categoryId null
}
export interface TxnUpdate {
  id: string;
  categoryId?: string | null; memo?: string | null; approved?: boolean;
  flagColor?: FlagColor | null; amount?: number; date?: string;
  subtransactions?: { amount: number; categoryId: string; memo: string | null }[]; // implies categoryId null
}
export interface CachedCategoryGroup { id: string; name: string; hidden: boolean; deleted: boolean }
export interface CachedCategory { id: string; groupId: string; name: string; hidden: boolean; deleted: boolean; sortIndex: number } // own flags only
export interface CachedAccount  { id: string; name: string; type: string; onBudget: boolean; closed: boolean; deleted: boolean; directImportLinked: boolean }
export interface CachedPayee    { id: string; name: string; transferAccountId: string | null; deleted: boolean }
export interface PlanDelta {
  serverKnowledge: number;
  transactions: YnabTxn[]; categoryGroups: CachedCategoryGroup[]; categories: CachedCategory[];
  accounts: CachedAccount[]; payees: CachedPayee[];
  /** Parents whose subtransactions all arrived deleted in this delta (un-split in YNAB). Optional addition. */
  unsplitTxnIds?: string[];
}

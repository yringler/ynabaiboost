// engine/load.ts — WP5 (DESIGN §8.5). Stub created by WP1.
import type { PossibleIntent } from "../../shared/schemas";
import type { DB } from "../env";
import type { YnabTxn } from "../ynab/types";

/** Txn ids the inbox, the matcher and manual linking must not offer: every intent's placeholder_txn_id
 *  (any status except 'none'/'failed'), every txn in matches (planned|applied), every ynab_txn_id and
 *  option transactionId of open reviews. Single source of truth for WP4 and WP5. */
export async function excludedTxnIds(_db: DB, _userId: string, _planId: string): Promise<Set<string>> {
  throw new Error("not implemented: excludedTxnIds");
}
/** Best open intent whose loose candidate score (§10.9 candidates filter) for this txn is ≥ 0.5, else null. */
export async function possibleIntentFor(_db: DB, _userId: string, _planId: string, _txns: YnabTxn[]): Promise<Map<string, PossibleIntent>> {
  throw new Error("not implemented: possibleIntentFor");
}

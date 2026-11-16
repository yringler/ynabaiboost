// domain/types.ts — WP5 (DESIGN §10.1). PURE: no I/O, no Env, no Date.now(). Created by WP1.
import type { Direction } from "../../shared/money";
import type { Allocation, MerchantKind, PlaceholderStatus, ReviewKind, ReviewOption, Settings } from "../../shared/schemas";
import type { YnabTxn } from "../ynab/types";

export interface DLine { id: string; categoryId: string; amount: number; tolerance: number; status: "open" | "matched"; description: string }
export interface DIntent {
  id: string; shortRef: string; payee: string; merchantKind: MerchantKind; direction: Direction;
  date: string; accountId: string | null; accountExplicit: boolean;
  total: number; tolerance: number; status: "pending" | "partial" | "review";
  placeholderTxnId: string | null; placeholderStatus: PlaceholderStatus; lines: DLine[];
}
export type DTxn = YnabTxn;   // from ynab/types.ts (type-only import is allowed)
export interface ReconcileInput {
  today: string; settings: Settings; decimalDigits: number;
  intents: DIntent[];               // status pending|partial, placeholder_status ≠ 'final' (review intents excluded)
  otherOpenAmazonIntents: DIntent[];// amazon intents in status review, or outside onlyIntentIds: used only for "fits another intent" checks
  txns: DTxn[];                     // cached, date ≥ today − (amazonWindowDays + 30), incl. deleted tombstones
  excluded: Set<string>;            // excludedTxnIds() minus each intent's own placeholder (handled in §10.7)
  uncategorizedIds: Set<string>;
  categoryNames: Map<string, string>; // for review summaries
}
export type Decision =
  | { kind: "finalize"; intentId: string; txnId: string; lineIds: string[] }      // memo tag already present
  | { kind: "ynab_auto"; intentId: string; txnId: string; allocation: Allocation[]; needsSplit: boolean }
  | { kind: "apply"; intentId: string; txnId: string; lineIds: string[]; allocation: Allocation[]; score: number; matchKind: "single" | "split" | "amazon_subset" }
  | { kind: "review"; intentId: string | null; txnId: string | null; reviewKind: ReviewKind; summary: string; options: Omit<ReviewOption, "label">[] }
    // intentId null => cross-intent review keyed by txnId; every option.intentId goes to status 'review'
  | { kind: "placeholder_missing"; intentId: string };

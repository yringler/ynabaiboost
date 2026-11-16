// src/worker/lib/audit.ts — DESIGN §8.1
import type { AuditAction, TxnSnapshot } from "../../shared/schemas";
import { FlagColor } from "../../shared/schemas";
import { auditLog } from "../db/schema";
import type { Actor, BatchItem, DB } from "../env";
import { newId } from "./ids";

export interface AuditInput {
  userId: string;
  actor: Actor;
  action: AuditAction;
  summary: string;
  intentId?: string | null;
  ynabTxnId?: string | null;
  before?: TxnSnapshot | null;
  after?: TxnSnapshot | null; // required for txn_* and inbox_approved rows
}

export function toSnapshot(t: {
  categoryId: string | null;
  approved: boolean;
  memo: string | null;
  flagColor: string | null;
  isSplit: boolean;
}): TxnSnapshot {
  const flag = FlagColor.safeParse(t.flagColor);
  return {
    categoryId: t.categoryId,
    approved: t.approved,
    memo: t.memo,
    flagColor: flag.success ? flag.data : null,
    isSplit: t.isSplit,
  };
}

const TXN_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>(["txn_categorized", "txn_split", "txn_approved", "inbox_approved"]);

/** Returns an un-awaited Drizzle insert so callers can put it in db.batch([...]). */
export function auditStmt(db: DB, e: AuditInput, now: number = Date.now()): BatchItem<"sqlite"> {
  if (TXN_ACTIONS.has(e.action) && (e.before == null || e.after == null)) {
    throw new Error(`auditStmt: ${e.action} requires before/after TxnSnapshot`);
  }
  return db.insert(auditLog).values({
    id: newId(),
    userId: e.userId,
    at: now,
    actor: e.actor,
    action: e.action,
    summary: e.summary,
    intentId: e.intentId ?? null,
    ynabTxnId: e.ynabTxnId ?? null,
    beforeJson: e.before ? JSON.stringify(e.before) : null,
    afterJson: e.after ? JSON.stringify(e.after) : null,
  });
}

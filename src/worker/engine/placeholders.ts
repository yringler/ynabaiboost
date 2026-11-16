// engine/placeholders.ts — WP5 (DESIGN §8.5, §10.7, D13). Placeholders, final entries and the delete guard.
import { and, eq } from "drizzle-orm";
import { minDate, todayIn } from "../../shared/dates";
import { toYnabAmount } from "../../shared/money";
import { intentLines, intents } from "../db/schema";
import { allocate } from "../domain/allocate";
import { fmtAmount } from "../domain/labels";
import { APPROX_PREFIX, did, hasTag, memoTag, mergeMemo } from "../domain/memo";
import { nudged } from "../domain/nudge";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { getAccounts, lastAccountForPayee, upsertTxnsStmts } from "../ynab/cache";
import type { NewTxn, YnabTxn } from "../ynab/types";
import type { EngineCtx } from "./reconcile";
import { upsertOpenReview } from "./reviews";
import { getLinesOf, requireIntent, runBatch, type IntentRow, type LineRow } from "./store";

const largestLine = (lines: LineRow[]): LineRow | undefined =>
  [...lines].sort((a, b) => b.amount - a.amount || a.idx - b.idx)[0];

const descriptions = (lines: LineRow[]): string => lines.map((l) => l.description).join(", ");

/** YNAB rejects dates "in the future" by its own clock (spike S3): a 400 that mentions the date. */
export function isFutureDateError(e: unknown): boolean {
  const cause = e instanceof AppError ? e.cause : e;
  if (typeof cause !== "object" || cause === null) return false;
  const c = cause as { status?: unknown; detail?: unknown; message?: unknown };
  const text = `${typeof c.detail === "string" ? c.detail : ""} ${typeof c.message === "string" ? c.message : ""}`;
  return c.status === 400 && /date|future/i.test(text);
}

async function createWithDateRetry(ctx: EngineCtx, txn: NewTxn): Promise<YnabTxn> {
  try {
    return await ctx.client.createTransaction(ctx.planId, txn);
  } catch (e) {
    const utc = todayIn("UTC");
    if (!isFutureDateError(e) || txn.date <= utc) throw e;
    return ctx.client.createTransaction(ctx.planId, { ...txn, date: utc });
  }
}

/** Creates a placeholder, or a final entry when the account is not direct-import-linked (§10.7). */
export async function createPlaceholder(ctx: EngineCtx, intentId: string): Promise<{ ok: boolean; kind: "placeholder" | "final" | "none"; warning: string | null }> {
  const { db, userId, planId, settings } = ctx;
  const intent = await requireIntent(db, userId, intentId);
  if (intent.placeholderStatus === "created" || intent.placeholderStatus === "auto_matched") return { ok: true, kind: "placeholder", warning: null };
  if (intent.placeholderStatus === "final") return { ok: true, kind: "final", warning: null };
  const lines = await getLinesOf(db, intentId);
  const now = Date.now();

  const account = intent.accountId ?? (await lastAccountForPayee(db, userId, planId, intent.payee)) ?? settings.defaultAccountId;
  if (!account) {
    await db.update(intents).set({ placeholderStatus: "none", updatedAt: now }).where(eq(intents.id, intentId));
    return { ok: false, kind: "none", warning: `${intent.payee}: no account – placeholder skipped` };
  }
  const acct = (await getAccounts(db, userId, planId)).find((a) => a.id === account);
  // Unknown to the cache (e.g. not synced yet): assume it imports, so nothing is recorded as final by mistake.
  const linked = acct?.directImportLinked ?? true;
  const payee = intent.payeeId ? { payeeId: intent.payeeId, payeeName: null } : { payeeId: null, payeeName: intent.payee };
  const cat = largestLine(lines)?.categoryId ?? null;
  const date = minDate(intent.intentDate, ctx.today);
  const tag = memoTag(intent.shortRef);
  const text = intent.memo ?? descriptions(lines);

  if (acct && !acct.onBudget) {
    // Tracking accounts take no categories (YNAB rejects the write): never pin a placeholder there.
    await db.update(intents).set({ placeholderStatus: "none", updatedAt: now }).where(eq(intents.id, intentId));
    return { ok: false, kind: "none", warning: `${intent.payee}: ${acct.name} is a tracking account – placeholder skipped` };
  }

  // YNAB first. Its failure is the only case where nothing exists in YNAB and 'failed' is the truth.
  let created: YnabTxn;
  let final: boolean;
  let amt: number;
  try {
    if (!linked) {
      const multi = new Set(lines.map((l) => l.categoryId)).size > 1;
      const subs = multi
        ? allocate(intent.totalAmount, lines, intent.direction, ctx.currency.decimalDigits).map((a) => ({ amount: a.amount, categoryId: a.categoryId, memo: a.memo }))
        : undefined;
      created = await createWithDateRetry(ctx, {
        accountId: account, date, amount: toYnabAmount(intent.totalAmount, intent.direction), ...payee,
        categoryId: multi ? null : cat, memo: mergeMemo(null, text, tag, did.recorded(intent.intentDate)), approved: true, flagColor: settings.flagColor,
        ...(subs ? { subtransactions: subs } : {}),
      });
      final = true;
      amt = intent.totalAmount;
    } else {
      amt = nudged(intent.totalAmount, intent.approximate, ctx.currency.decimalDigits);
      created = await createWithDateRetry(ctx, {
        accountId: account, date, amount: toYnabAmount(amt, intent.direction), ...payee, categoryId: cat,
        memo: mergeMemo(null, `${intent.approximate ? APPROX_PREFIX : ""}${text}`, tag, did.placeholder(intent.totalAmount, intent.approximate, ctx.currency)),
        approved: true, flagColor: settings.flagColor,
      });
      final = false;
    }
  } catch (e) {
    await db.update(intents).set({ placeholderStatus: "failed", updatedAt: now }).where(eq(intents.id, intentId));
    const why = e instanceof AppError ? e.message : "unexpected error";
    return { ok: false, kind: linked ? "placeholder" : "final", warning: `${intent.payee}: placeholder could not be created (${why})` };
  }

  // The txn exists in YNAB now: its id must reach D1, or nothing would ever clean it up (double count).
  const intentSet = final
    ? { placeholderTxnId: created.id, placeholderAmount: amt, placeholderStatus: "final" as const,
        accountId: intent.accountId ?? account, status: "resolved" as const, resolvedAt: now, updatedAt: now }
    : { placeholderTxnId: created.id, placeholderAmount: amt, placeholderStatus: "created" as const, updatedAt: now };
  try {
    await runBatch(db, [
      ...upsertTxnsStmts(db, userId, planId, [created], now),
      db.update(intents).set(intentSet).where(eq(intents.id, intentId)),
      ...(final ? [db.update(intentLines).set({ status: "matched", matchedTxnId: created.id }).where(eq(intentLines.intentId, intentId))] : []),
      auditStmt(db, final
        ? {
          userId, actor: ctx.actor, action: "final_entry_created", intentId, ynabTxnId: created.id,
          summary: `Recorded ${intent.payee} ${fmtAmount(intent.totalAmount, ctx.currency.decimalDigits)} (no bank import on this account)`,
        }
        : {
          userId, actor: ctx.actor, action: "placeholder_created", intentId, ynabTxnId: created.id,
          summary: `Placeholder ${intent.payee} ${fmtAmount(amt, ctx.currency.decimalDigits)}`,
        }, now),
    ]);
  } catch {
    // Minimal write of the id (the cache row and audit are not needed for safety). If even that fails,
    // undo the YNAB create: the txn is brand new and untouched, so deleting it is safe.
    try {
      await db.update(intents).set(intentSet).where(eq(intents.id, intentId));
      if (final) await db.update(intentLines).set({ status: "matched", matchedTxnId: created.id }).where(eq(intentLines.intentId, intentId));
    } catch {
      await ctx.client.deleteTransaction(planId, created.id).catch(() => undefined);
      return { ok: false, kind: final ? "final" : "placeholder", warning: `${intent.payee}: placeholder could not be saved (database error)` };
    }
  }
  return { ok: true, kind: final ? "final" : "placeholder", warning: null };
}

/** The live placeholder when it is still ours to write (§10.7 guard), else null. On null, the cause is already
 *  handled: a deleted placeholder becomes 'missing'; a matched or edited one is cached, audited and (unless
 *  `review` is false) gets a ynab_matched_other review. Never write amount/date/memo to a txn this rejects. */
export async function livePlaceholder(ctx: EngineCtx, intent: IntentRow, what: string, review = true): Promise<YnabTxn | null> {
  const { db, userId, planId } = ctx;
  if (intent.placeholderStatus !== "created" || !intent.placeholderTxnId) return null;
  const now = Date.now();
  const p = await ctx.client.getTransaction(planId, intent.placeholderTxnId);
  if (p === null || p.deleted) {
    // The user deleted it in YNAB (§10.7 placeholder_missing).
    await runBatch(db, [
      ...(p ? upsertTxnsStmts(db, userId, planId, [p], now) : []),
      db.update(intents).set({ placeholderStatus: "missing", updatedAt: now }).where(eq(intents.id, intent.id)),
    ]);
    return null;
  }
  if (isUntouchedPlaceholder(p, intent)) return p;
  await runBatch(db, [
    ...upsertTxnsStmts(db, userId, planId, [p], now),
    auditStmt(db, {
      userId, actor: ctx.actor, action: "placeholder_delete_refused", intentId: intent.id, ynabTxnId: p.id,
      summary: `Placeholder for ${intent.payee} was changed in YNAB (likely matched to a bank import); not ${what}`,
    }, now),
  ]);
  if (review) {
    await upsertOpenReview(ctx, {
      intentId: intent.id, txnId: p.id, kind: "ynab_matched_other", options: [],
      summary: `The placeholder for ${intent.payee} was matched or edited in YNAB, so it was not ${what}. Check it in YNAB.`,
    }, now);
  }
  return null;
}

/** Re-applies the D13 nudge. Also moves the placeholder to the largest remaining line's category. */
export async function updatePlaceholderAmount(ctx: EngineCtx, intentId: string, remaining: number): Promise<void> {
  const { db, userId, planId } = ctx;
  const intent = await requireIntent(db, userId, intentId);
  if (intent.placeholderStatus !== "created" || !intent.placeholderTxnId) return;
  const open = (await getLinesOf(db, intentId)).filter((l) => l.status === "open");
  const approximate = intent.approximate || open.some((l) => l.approximate);
  const amt = nudged(remaining, approximate, ctx.currency.decimalDigits);
  const cat = largestLine(open)?.categoryId;
  // Live guard: YNAB may have merged the placeholder with a real import since the last sync.
  const live = await livePlaceholder(ctx, intent, "re-amounted");
  if (!live) return;
  const now = Date.now();
  const memo = mergeMemo(live.memo, null, memoTag(intent.shortRef), did.remaining(remaining, approximate, ctx.currency));
  const res = await ctx.client.updateTransactions(planId, [{
    id: intent.placeholderTxnId, amount: toYnabAmount(amt, intent.direction), ...(cat ? { categoryId: cat } : {}),
    ...(memo !== (live.memo ?? "") ? { memo } : {}),
  }]);
  await runBatch(db, [
    ...upsertTxnsStmts(db, userId, planId, res, now),
    db.update(intents).set({ placeholderAmount: amt, updatedAt: now }).where(eq(intents.id, intentId)),
    auditStmt(db, {
      userId, actor: ctx.actor, action: "placeholder_updated", intentId, ynabTxnId: intent.placeholderTxnId,
      summary: `Placeholder ${intent.payee} reduced to ${fmtAmount(amt, ctx.currency.decimalDigits)}`,
    }, now),
  ]);
}

/** Is the live txn still our untouched placeholder? (§10.7 guard) */
export function isUntouchedPlaceholder(p: YnabTxn, intent: Pick<IntentRow, "placeholderAmount" | "shortRef">): boolean {
  return p.importId === null && p.matchedTransactionId === null && p.cleared === "uncleared"
    && Math.abs(p.amount) === intent.placeholderAmount && hasTag(p.memo, intent.shortRef) && !p.isSplit;
}

/** §10.7 guard. Returns "deleted", "gone" (404) or "refused" (+ ynab_matched_other review unless cancelling). */
export async function safeDeletePlaceholder(ctx: EngineCtx, intentId: string, reason: "resolved" | "cancelled" | "stale_delete"): Promise<"deleted" | "gone" | "refused"> {
  const { db, userId, planId } = ctx;
  const intent = await requireIntent(db, userId, intentId);
  if (intent.placeholderStatus !== "created" || !intent.placeholderTxnId) return "gone"; // 'final' entries are never deleted
  const now = Date.now();
  const p = await ctx.client.getTransaction(planId, intent.placeholderTxnId); // live read, not the cache
  if (p === null || p.deleted) {
    await db.update(intents).set({ placeholderStatus: "deleted", updatedAt: now }).where(eq(intents.id, intentId));
    return "gone";
  }
  if (!isUntouchedPlaceholder(p, intent)) {
    await runBatch(db, [
      ...upsertTxnsStmts(db, userId, planId, [p], now),
      auditStmt(db, {
        userId, actor: ctx.actor, action: "placeholder_delete_refused", intentId, ynabTxnId: p.id,
        summary: `Placeholder for ${intent.payee} was changed in YNAB (likely matched to a bank import); left untouched`,
      }, now),
    ]);
    if (reason !== "cancelled") {
      await upsertOpenReview(ctx, {
        intentId, txnId: p.id, kind: "ynab_matched_other", options: [],
        summary: `The placeholder for ${intent.payee} was matched or edited in YNAB, so it was not deleted. Check it in YNAB.`,
      }, now);
    }
    return "refused";
  }
  await ctx.client.deleteTransaction(planId, p.id);
  await runBatch(db, [
    ...upsertTxnsStmts(db, userId, planId, [{ ...p, deleted: true }], now),
    db.update(intents).set({ placeholderStatus: "deleted", updatedAt: now }).where(and(eq(intents.id, intentId), eq(intents.userId, userId))),
    auditStmt(db, {
      userId, actor: ctx.actor, action: "placeholder_deleted", intentId, ynabTxnId: p.id,
      summary: `Placeholder for ${intent.payee} deleted (${reason})`,
    }, now),
  ]);
  return "deleted";
}

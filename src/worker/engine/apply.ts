// engine/apply.ts — WP5 (DESIGN §8.5, §10.9). Applies one match: YNAB first, then D1, then the placeholder.
import { and, eq, inArray } from "drizzle-orm";
import { Allocation, type FlagColor } from "../../shared/schemas";
import { intentLines, intents, matches } from "../db/schema";
import { fmtAmount, txnPayee } from "../domain/labels";
import { memoTag, mergeMemo } from "../domain/memo";
import { AUTO } from "../domain/score";
import type { BatchItem } from "../env";
import { auditStmt, toSnapshot } from "../lib/audit";
import { AppError } from "../lib/errors";
import { newId } from "../lib/ids";
import { getCachedTxns, isUncategorized, upsertTxnsStmts } from "../ynab/cache";
import type { TxnUpdate, YnabTxn } from "../ynab/types";
import { safeDeletePlaceholder, updatePlaceholderAmount } from "./placeholders";
import type { EngineCtx } from "./reconcile";
import { upsertOpenReview } from "./reviews";
import { getLinesOf, isUniqueViolation, requireIntent, runBatch, type IntentRow, type LineRow } from "./store";

export type MatchKind = "ynab_auto" | "single" | "split" | "amazon_subset" | "manual" | "review";
export interface MatchInput {
  intentId: string; txnId: string; lineIds: string[]; allocation: Allocation[]; score: number | null; kind: MatchKind;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** The cached txn, or a live read when it is not cached yet. */
export async function loadTxn(ctx: EngineCtx, txnId: string): Promise<YnabTxn | null> {
  const [cached] = await getCachedTxns(ctx.db, ctx.userId, ctx.planId, { ids: [txnId], includeDeleted: true });
  if (cached) return cached;
  return ctx.client.getTransaction(ctx.planId, txnId);
}

/** A live read of one txn, written through to the cache. */
async function liveTxn(ctx: EngineCtx, txnId: string, now: number): Promise<YnabTxn | null> {
  const t = await ctx.client.getTransaction(ctx.planId, txnId);
  if (t) await runBatch(ctx.db, upsertTxnsStmts(ctx.db, ctx.userId, ctx.planId, [t], now));
  return t;
}

/** Inserts the `planned` match row; the partial unique index rejects a txn that is already planned/applied. */
async function insertPlanned(ctx: EngineCtx, m: MatchInput, now: number): Promise<string> {
  const id = newId();
  try {
    await ctx.db.insert(matches).values({
      id, userId: ctx.userId, intentId: m.intentId, ynabTxnId: m.txnId, kind: m.kind,
      lineIds: JSON.stringify(m.lineIds), allocation: JSON.stringify(m.allocation), score: m.score,
      state: "planned", error: null, createdAt: now, appliedAt: null,
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("conflict", "This transaction is already matched to an intent", e);
    throw e;
  }
  return id;
}

async function failMatch(ctx: EngineCtx, matchId: string, error: string): Promise<void> {
  await ctx.db.update(matches).set({ state: "failed", error: error.slice(0, 500) }).where(eq(matches.id, matchId));
}

export async function applyMatch(ctx: EngineCtx, m: MatchInput): Promise<void> {
  if (m.lineIds.length === 0) throw new AppError("validation", "A match needs at least one line");
  Allocation.array().min(1).parse(m.allocation);
  const now = Date.now();
  const matchId = await insertPlanned(ctx, m, now);
  let applied: { intentId: string; txn: YnabTxn } | null;
  try {
    applied = await applyPlanned(ctx, m, matchId, now);
  } catch (e) {
    await failMatch(ctx, matchId, errMessage(e)).catch(() => undefined);
    throw e;
  }
  // The match is committed; a placeholder error from here on is retried by the next cycle (finishCompleted).
  if (applied) await afterMatch(ctx, applied.intentId, applied.txn, m.kind, now);
}

/** Steps 2–5. Returns the updated txn once YNAB and D1 are written, or null for a split_conflict. */
async function applyPlanned(ctx: EngineCtx, m: MatchInput, matchId: string, now: number): Promise<{ intentId: string; txn: YnabTxn } | null> {
  const { db, userId, planId, settings } = ctx;
  const intent = await requireIntent(db, userId, m.intentId);
  const lines = await getLinesOf(db, intent.id);
  const chosen = lines.filter((l) => m.lineIds.includes(l.id));
  if (chosen.length !== m.lineIds.length) throw new AppError("validation", "Unknown line for this intent");
  if (chosen.some((l) => l.status !== "open")) throw new AppError("conflict", "A line of this intent is already matched");

  // Interactive kinds and splits act on a live read: the cache can be hours old (cron every 6 h) and the user
  // may have split or recategorized the txn in YNAB since, which decides split_conflict vs. a normal write.
  // Amazon subset matches (§10.6a may auto-apply several charges in a row) are always re-read live as well.
  const live = m.kind === "manual" || m.kind === "review" || m.kind === "amazon_subset" || m.allocation.length > 1;
  const t = live ? await liveTxn(ctx, m.txnId, now) : await loadTxn(ctx, m.txnId);
  if (!t || t.deleted) throw new AppError("not_found", "Transaction not found in YNAB");
  const allocSum = m.allocation.reduce((s, a) => s + a.amount, 0);
  if (allocSum !== t.amount) throw new AppError("validation", "Allocation does not add up to the transaction amount");

  // ── 3. build the update ──
  const tag = memoTag(intent.shortRef);
  const summary = chosen.map((l) => l.description).join(", ");
  const memo = mergeMemo(t.memo, summary, tag);
  const u: TxnUpdate = { id: t.id };
  if (memo !== (t.memo ?? "")) u.memo = memo;
  if (t.flagColor === null && settings.flagColor !== null) u.flagColor = settings.flagColor satisfies FlagColor;
  // §10.9: only user-confirmed kinds or a strong score. ynab_auto has no score (YNAB matched on amount alone).
  const confident = m.kind === "manual" || m.kind === "review" || (m.score ?? 0) >= AUTO;
  const approve = settings.autoApproveMatches && confident && !t.approved;
  if (approve) u.approved = true;

  if (t.isSplit) {
    // YNAB cannot edit an existing split: tag it, open a split_conflict review, mark the match failed.
    const writes = u.memo !== undefined ? await ctx.client.updateTransactions(planId, [{ id: t.id, memo }]) : [];
    const after = writes.find((x) => x.id === t.id) ?? t;
    await runBatch(db, [
      ...upsertTxnsStmts(db, userId, planId, [after], now),
      db.update(matches).set({ state: "failed", error: "split_conflict" }).where(eq(matches.id, matchId)),
      ...(u.memo !== undefined ? [auditStmt(db, {
        userId, actor: ctx.actor, action: "txn_categorized", summary: `Tagged split ${txnPayee(t)} for ${intent.payee}`,
        intentId: intent.id, ynabTxnId: t.id, before: toSnapshot(t), after: toSnapshot(after),
      }, now)] : []),
    ]);
    await upsertOpenReview(ctx, {
      intentId: intent.id, txnId: t.id, kind: "split_conflict", options: [],
      summary: `${txnPayee(t)} ${fmtAmount(t.amount, ctx.currency.decimalDigits)} is already split in YNAB. Split it there: ${m.allocation
        .map((a) => `${a.memo ?? a.categoryId} ${fmtAmount(a.amount, ctx.currency.decimalDigits)}`).join(", ")}`.slice(0, 500),
    }, now);
    return null;
  }

  const [only] = m.allocation;
  const split = m.allocation.length > 1;
  if (!split && only) {
    if (t.categoryId !== only.categoryId) u.categoryId = only.categoryId;
  } else {
    u.categoryId = null;
    u.subtransactions = m.allocation.map((a) => ({ amount: a.amount, categoryId: a.categoryId, memo: a.memo }));
  }
  if (t.approved && !(await isUncategorized(db, userId, planId, t.categoryId)) && !["manual", "review", "ynab_auto"].includes(m.kind)) {
    // §10.5 makes approved, categorized imports review-only; reaching this is a planner bug.
    throw new AppError("conflict", "Import already approved in YNAB; it needs a review");
  }

  // ── 4. YNAB first ──
  const writes = Object.keys(u).length > 1;
  let after = t;
  if (writes) {
    const res = await ctx.client.updateTransactions(planId, [u]);
    after = res.find((x) => x.id === t.id) ?? { ...t, ...pickDefined(u), isSplit: split || t.isSplit };
  }

  // ── 5. then D1, atomically ──
  const stmts: BatchItem<"sqlite">[] = [
    ...upsertTxnsStmts(db, userId, planId, [after], now),
    db.update(matches).set({ state: "applied", appliedAt: now, error: null }).where(eq(matches.id, matchId)),
    db.update(intentLines).set({ status: "matched", matchedTxnId: t.id }).where(and(eq(intentLines.intentId, intent.id), inArray(intentLines.id, m.lineIds))),
  ];
  if (writes) {
    stmts.push(auditStmt(db, {
      userId, actor: ctx.actor, action: split ? "txn_split" : "txn_categorized",
      summary: `${txnPayee(t)} ${fmtAmount(t.amount, ctx.currency.decimalDigits)} → ${intent.payee}: ${summary}`.slice(0, 300),
      intentId: intent.id, ynabTxnId: t.id, before: toSnapshot(t), after: toSnapshot(after),
    }, now));
    if (approve) {
      stmts.push(auditStmt(db, {
        userId, actor: ctx.actor, action: "txn_approved", summary: `Approved ${txnPayee(t)} ${fmtAmount(t.amount, ctx.currency.decimalDigits)}`,
        intentId: intent.id, ynabTxnId: t.id, before: toSnapshot(t), after: toSnapshot(after),
      }, now));
    }
  }
  await runBatch(db, stmts);
  return { intentId: intent.id, txn: after };
}

function pickDefined(u: TxnUpdate): Partial<YnabTxn> {
  const out: Partial<YnabTxn> = {};
  if (u.memo !== undefined) out.memo = u.memo;
  if (u.approved !== undefined) out.approved = u.approved;
  if (u.flagColor !== undefined) out.flagColor = u.flagColor;
  if (u.categoryId !== undefined) out.categoryId = u.categoryId;
  return out;
}

/** True when `t` is (or was merged with) the intent's own placeholder. */
function isPlaceholderTarget(intent: IntentRow, t: YnabTxn): boolean {
  const pid = intent.placeholderTxnId;
  return pid !== null && (t.id === pid || t.matchedTransactionId === pid);
}

/** §10.9 step 6: resolve the intent, or mark it partial and shrink its placeholder. Also used by the finalize
 *  repair and to finish intents whose placeholder delete failed in an earlier cycle. On a placeholder error the
 *  intent is left unresolved (all lines matched) so the next cycle retries; the error is rethrown. */
export async function afterMatch(ctx: EngineCtx, intentId: string, t: YnabTxn | null, kind: MatchKind | "finalize" | "retry", now = Date.now()): Promise<void> {
  const { db, userId } = ctx;
  let intent = await requireIntent(db, userId, intentId);
  const lines: LineRow[] = await getLinesOf(db, intentId);
  const remaining = lines.filter((l) => l.status === "open");

  if (intent.placeholderStatus === "created" && (kind === "ynab_auto" || (t !== null && isPlaceholderTarget(intent, t)))) {
    await db.update(intents).set({ placeholderStatus: "auto_matched", updatedAt: now }).where(eq(intents.id, intentId));
    intent = { ...intent, placeholderStatus: "auto_matched" };
  }

  if (remaining.length === 0) {
    if (intent.placeholderStatus === "created") await safeDeletePlaceholder(ctx, intentId, "resolved");
    await runBatch(db, [
      db.update(intents).set({ status: "resolved", resolvedAt: now, updatedAt: now }).where(eq(intents.id, intentId)),
      auditStmt(db, { userId, actor: ctx.actor, action: "intent_resolved", summary: `${intent.payee} resolved`, intentId, ynabTxnId: t?.id ?? null }, now),
    ]);
    return;
  }
  await db.update(intents).set({ status: "partial", updatedAt: now }).where(eq(intents.id, intentId));
  if (intent.placeholderStatus === "created") {
    await updatePlaceholderAmount(ctx, intentId, remaining.reduce((s, l) => s + l.amount, 0));
  }
}

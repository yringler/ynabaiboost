// engine/reconcile.ts — WP5 (DESIGN §8.5, §10.9). Executes planner decisions; countOpen; pruning.
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { addDays } from "../../shared/dates";
import { Allocation, type CurrencyFormat, type ReviewOption, type Settings } from "../../shared/schemas";
import { auditLog, intentLines, intents, matches, reviews, sessions, ynabTransactions } from "../db/schema";
import { allocate } from "../domain/allocate";
import { optionLabel } from "../domain/labels";
import { planReconciliation } from "../domain/plan";
import type { DIntent, DTxn, Decision, ReconcileInput } from "../domain/types";
import type { Actor, DB } from "../env";
import { AppError } from "../lib/errors";
import { newId } from "../lib/ids";
import type { YnabClient } from "../ynab/client";
import type { SyncDelta } from "../ynab/sync";
import { afterMatch, applyMatch, loadTxn, type MatchKind } from "./apply";
import { loadReconcileInput } from "./load";
import { upsertOpenReview } from "./reviews";
import { OPEN_STATUSES, getLinesOf, isUniqueViolation, requireIntent, runBatch } from "./store";

export interface EngineCtx {
  env: Env; db: DB; client: YnabClient; userId: string; planId: string;
  settings: Settings; currency: CurrencyFormat; today: string; actor: Actor;
}
export interface ReconcileSummary { matched: number; reviewsCreated: number; stale: number; errors: string[] }

/** `planned` match rows older than this are treated as failed (crash between YNAB write and D1, §10.9). */
export const PLANNED_TIMEOUT_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

const errMessage = (e: unknown): string => (e instanceof AppError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 300);

/** onlyIntentIds: plan decisions only for these intents (other intents' txns are still excluded). */
export async function reconcileUser(ctx: EngineCtx, delta: SyncDelta, opts?: { onlyIntentIds?: string[] }): Promise<ReconcileSummary> {
  void delta; // the planner always looks at the whole cached window: intents change too, not only txns
  const summary: ReconcileSummary = { matched: 0, reviewsCreated: 0, stale: 0, errors: [] };
  const now = Date.now();
  const { db, userId } = ctx;

  await db.update(matches).set({ state: "failed", error: "planned timeout" })
    .where(and(eq(matches.userId, userId), eq(matches.state, "planned"), lt(matches.createdAt, now - PLANNED_TIMEOUT_MS)));
  await finishCompleted(ctx, summary, opts?.onlyIntentIds);

  const input = await loadReconcileInput(ctx, opts);
  const decisions = planReconciliation(input);
  for (const d of decisions) {
    try {
      await execute(ctx, d, input, summary);
    } catch (e) {
      summary.errors.push(`${d.kind} ${"intentId" in d && d.intentId ? d.intentId : ("txnId" in d ? d.txnId : "")}: ${errMessage(e)}`);
    }
  }

  summary.stale = (await countOpen(db, userId, ctx.planId, ctx.today)).stale;
  if (ctx.actor === "cron") {
    try {
      await prune(ctx, now);
    } catch (e) {
      summary.errors.push(`prune: ${errMessage(e)}`);
    }
  }
  return summary;
}

/** Retries step 6 for open intents whose lines are all matched (an earlier placeholder delete failed). */
async function finishCompleted(ctx: EngineCtx, summary: ReconcileSummary, only?: string[]): Promise<void> {
  const rows = await ctx.db.select({ id: intents.id }).from(intents).where(and(
    eq(intents.userId, ctx.userId), eq(intents.planId, ctx.planId), inArray(intents.status, ["pending", "partial"]),
    sql`NOT EXISTS (SELECT 1 FROM ${intentLines} WHERE ${intentLines.intentId} = ${intents.id} AND ${intentLines.status} = 'open')`,
    sql`EXISTS (SELECT 1 FROM ${intentLines} WHERE ${intentLines.intentId} = ${intents.id})`,
  )).all();
  for (const r of rows) {
    if (only && !only.includes(r.id)) continue;
    try {
      await afterMatch(ctx, r.id, null, "retry");
    } catch (e) {
      summary.errors.push(`finish ${r.id}: ${errMessage(e)}`);
    }
  }
}

async function execute(ctx: EngineCtx, d: Decision, input: ReconcileInput, summary: ReconcileSummary): Promise<void> {
  switch (d.kind) {
    case "finalize":
      await finalize(ctx, d.intentId, d.txnId, d.lineIds);
      summary.matched++;
      return;
    case "ynab_auto":
      await applyMatch(ctx, {
        intentId: d.intentId, txnId: d.txnId, allocation: d.allocation, score: null, kind: "ynab_auto",
        lineIds: (await getLinesOf(ctx.db, d.intentId)).filter((l) => l.status === "open").map((l) => l.id),
      });
      summary.matched++;
      return;
    case "apply":
      await applyMatch(ctx, { intentId: d.intentId, txnId: d.txnId, lineIds: d.lineIds, allocation: d.allocation, score: d.score, kind: d.matchKind });
      summary.matched++;
      return;
    case "review": {
      const options = labelOptions(d.options, d.reviewKind, d.intentId === null, input);
      const r = await upsertOpenReview(ctx, { intentId: d.intentId, txnId: d.txnId, kind: d.reviewKind, summary: d.summary, options });
      if (r?.created) summary.reviewsCreated++;
      return;
    }
    case "placeholder_missing":
      await ctx.db.update(intents).set({ placeholderStatus: "missing", updatedAt: Date.now() })
        .where(and(eq(intents.id, d.intentId), eq(intents.userId, ctx.userId), eq(intents.placeholderStatus, "created")));
      return;
  }
}

export function labelOptions(opts: Omit<ReviewOption, "label">[], kind: string, cross: boolean, input: ReconcileInput): ReviewOption[] {
  const txns = new Map<string, DTxn>(input.txns.map((t) => [t.id, t]));
  const its = new Map<string, DIntent>([...input.intents, ...input.otherOpenAmazonIntents].map((i) => [i.id, i]));
  return opts.map((o) => {
    const i = its.get(o.intentId);
    return {
      ...o,
      label: optionLabel(o, txns.get(o.transactionId), i?.lines ?? [], input.decimalDigits, {
        subset: kind === "amazon_split", ...(cross && i ? { payee: `${i.payee} (${i.date})` } : {}),
      }),
    };
  });
}

/** Crash repair: the import already carries our memo tag but D1 has no live match. Records the match without
 *  writing YNAB again, using the failed match row's lines/allocation when there is one. */
async function finalize(ctx: EngineCtx, intentId: string, txnId: string, fallbackLineIds: string[]): Promise<void> {
  const { db, userId } = ctx;
  const now = Date.now();
  const intent = await requireIntent(db, userId, intentId);
  const lines = await getLinesOf(db, intentId);
  const open = new Set(lines.filter((l) => l.status === "open").map((l) => l.id));
  const t = await loadTxn(ctx, txnId);
  if (!t) throw new AppError("not_found", "Tagged transaction not found");
  const prev = await db.select().from(matches)
    .where(and(eq(matches.userId, userId), eq(matches.intentId, intentId), eq(matches.ynabTxnId, txnId), eq(matches.state, "failed")))
    .orderBy(desc(matches.createdAt)).get();
  let lineIds = fallbackLineIds.filter((id) => open.has(id));
  let allocation: Allocation[] = [];
  let kind: MatchKind = "single";
  if (prev) {
    try {
      const ids = (JSON.parse(prev.lineIds) as unknown[]).filter((x): x is string => typeof x === "string" && open.has(x));
      const alloc = Allocation.array().safeParse(JSON.parse(prev.allocation));
      if (ids.length) lineIds = ids;
      if (alloc.success) allocation = alloc.data;
      kind = prev.kind;
    } catch {
      // keep the fallbacks
    }
  }
  if (lineIds.length === 0) throw new AppError("conflict", "No open lines left to finalize");
  if (allocation.length === 0) {
    allocation = allocate(Math.abs(t.amount), lines.filter((l) => lineIds.includes(l.id)), intent.direction, ctx.currency.decimalDigits);
  }
  try {
    await runBatch(db, [
      db.insert(matches).values({
        id: newId(), userId, intentId, ynabTxnId: txnId, kind, lineIds: JSON.stringify(lineIds), allocation: JSON.stringify(allocation),
        score: prev?.score ?? null, state: "applied", error: null, createdAt: now, appliedAt: now,
      }),
      db.update(intentLines).set({ status: "matched", matchedTxnId: txnId }).where(and(eq(intentLines.intentId, intentId), inArray(intentLines.id, lineIds))),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("conflict", "Transaction already matched", e);
    throw e;
  }
  await afterMatch(ctx, intentId, t, "finalize", now);
}

/** Counts for /api/me: pending = open, not stale, not in review; stale = open and past expires_on; review = open reviews. */
export async function countOpen(db: DB, userId: string, planId: string, today: string): Promise<{ pending: number; stale: number; review: number }> {
  const base = and(eq(intents.userId, userId), eq(intents.planId, planId));
  const p = await db.select({ n: sql<number>`count(*)` }).from(intents)
    .where(and(base, inArray(intents.status, ["pending", "partial"]), sql`${intents.expiresOn} >= ${today}`)).get();
  const s = await db.select({ n: sql<number>`count(*)` }).from(intents)
    .where(and(base, inArray(intents.status, [...OPEN_STATUSES]), lt(intents.expiresOn, today))).get();
  const r = await db.select({ n: sql<number>`count(*)` }).from(reviews)
    .where(and(eq(reviews.userId, userId), eq(reviews.status, "open"))).get();
  return { pending: p?.n ?? 0, stale: s?.n ?? 0, review: r?.n ?? 0 };
}

/** Cron-only housekeeping (§10.9): old closed intents, old audit rows, old cached txns no open intent needs, expired sessions. */
async function prune(ctx: EngineCtx, now: number): Promise<void> {
  const { db, userId, planId } = ctx;
  await db.delete(intents).where(and(
    eq(intents.userId, userId), inArray(intents.status, ["resolved", "cancelled"]),
    lt(sql`COALESCE(${intents.resolvedAt}, ${intents.updatedAt})`, now - 90 * DAY_MS),
  ));
  await db.delete(auditLog).where(and(eq(auditLog.userId, userId), lt(auditLog.at, now - 180 * DAY_MS)));
  const keep = new Set<string>();
  const openRows = await db.select({ id: intents.id, ph: intents.placeholderTxnId }).from(intents)
    .where(and(eq(intents.userId, userId), eq(intents.planId, planId), inArray(intents.status, [...OPEN_STATUSES]))).all();
  for (const r of openRows) if (r.ph) keep.add(r.ph);
  const openIds = openRows.map((r) => r.id);
  for (let k = 0; k < openIds.length; k += 90) {
    const ms = await db.select({ id: matches.ynabTxnId }).from(matches).where(inArray(matches.intentId, openIds.slice(k, k + 90))).all();
    for (const m of ms) keep.add(m.id);
  }
  const old = and(eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId), lt(ynabTransactions.date, addDays(ctx.today, -120)));
  const keepIds = [...keep];
  if (keepIds.length <= 90) {
    await db.delete(ynabTransactions).where(keepIds.length ? and(old, notInArray(ynabTransactions.id, keepIds)) : old);
  } else {
    const ids = await db.select({ id: ynabTransactions.id }).from(ynabTransactions).where(old).all();
    const drop = ids.map((r) => r.id).filter((id) => !keep.has(id));
    for (let k = 0; k < drop.length; k += 90) {
      await db.delete(ynabTransactions).where(and(eq(ynabTransactions.userId, userId), inArray(ynabTransactions.id, drop.slice(k, k + 90))));
    }
  }
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now)));
}

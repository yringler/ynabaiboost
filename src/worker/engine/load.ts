// engine/load.ts — WP5 (DESIGN §8.5, §10.9). Loads planner input from D1; excludedTxnIds; possibleIntentFor.
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { addDays } from "../../shared/dates";
import type { PossibleIntent } from "../../shared/schemas";
import { getSettings } from "../auth/settings";
import { intents, matches } from "../db/schema";
import { POSSIBLE_MIN, looseScore } from "../domain/score";
import type { DIntent, ReconcileInput } from "../domain/types";
import type { DB } from "../env";
import { getCachedTxns } from "../ynab/cache";
import type { YnabTxn } from "../ynab/types";
import type { EngineCtx } from "./reconcile";
import { parseOptions } from "./reviews";
import { OPEN_STATUSES, categoryNames, getLines, openReviews, toDIntent, uncategorizedIds, type IntentRow } from "./store";

/** Txn ids the inbox, the matcher and manual linking must not offer: every intent's placeholder_txn_id
 *  (any status except 'none'/'failed'), every txn in matches (planned|applied), every ynab_txn_id and
 *  option transactionId of open reviews. Single source of truth for WP4 and WP5. */
export async function excludedTxnIds(db: DB, userId: string, planId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const ph = await db.select({ id: intents.placeholderTxnId }).from(intents).where(and(
    eq(intents.userId, userId), eq(intents.planId, planId), isNotNull(intents.placeholderTxnId),
    notInArray(intents.placeholderStatus, ["none", "failed"]),
  )).all();
  for (const r of ph) if (r.id) out.add(r.id);
  const ms = await db.select({ id: matches.ynabTxnId }).from(matches)
    .innerJoin(intents, eq(intents.id, matches.intentId))
    .where(and(eq(matches.userId, userId), eq(intents.planId, planId), inArray(matches.state, ["planned", "applied"]))).all();
  for (const r of ms) out.add(r.id);
  for (const r of await openReviews(db, userId)) {
    if (r.ynabTxnId) out.add(r.ynabTxnId);
    for (const o of parseOptions(r.options)) out.add(o.transactionId);
  }
  return out;
}

/** Open intents (pending | partial | review) of a plan as planner DIntents, oldest first. */
export async function loadOpenIntents(db: DB, userId: string, planId: string): Promise<{ rows: IntentRow[]; intents: DIntent[] }> {
  const rows = await db.select().from(intents)
    .where(and(eq(intents.userId, userId), eq(intents.planId, planId), inArray(intents.status, [...OPEN_STATUSES])))
    .orderBy(intents.intentDate, intents.id).all();
  const lines = await getLines(db, rows.map((r) => r.id));
  return { rows, intents: rows.map((r) => toDIntent(r, lines.get(r.id) ?? [])) };
}

/** Best open intent whose loose candidate score (§10.9 candidates filter) for this txn is ≥ 0.5, else null. */
export async function possibleIntentFor(db: DB, userId: string, planId: string, txns: YnabTxn[]): Promise<Map<string, PossibleIntent>> {
  const out = new Map<string, PossibleIntent>();
  if (txns.length === 0) return out;
  const { intents: open } = await loadOpenIntents(db, userId, planId);
  const candidates = open.filter((i) => i.placeholderStatus !== "final" && i.lines.some((l) => l.status === "open"));
  if (candidates.length === 0) return out;
  const settings = await getSettings(db, userId);
  const excluded = await excludedTxnIds(db, userId, planId);
  for (const t of txns) {
    let best: { i: DIntent; s: number } | null = null;
    for (const i of candidates) {
      const s = looseScore(i, t, excluded, settings.amazonWindowDays);
      if (s !== null && s >= POSSIBLE_MIN && (best === null || s > best.s)) best = { i, s };
    }
    if (best) out.set(t.id, { intentId: best.i.id, payee: best.i.payee, totalAmount: best.i.total, date: best.i.date });
  }
  return out;
}

/** Planner input (§10.1). onlyIntentIds restricts which intents get decisions; the others' txns stay excluded. */
export async function loadReconcileInput(ctx: EngineCtx, opts: { onlyIntentIds?: string[] } = {}): Promise<ReconcileInput> {
  const { db, userId, planId, settings } = ctx;
  const { intents: open } = await loadOpenIntents(db, userId, planId);
  const scope = opts.onlyIntentIds ? new Set(opts.onlyIntentIds) : null;
  const inRun = open.filter((i) => (i.status === "pending" || i.status === "partial") && i.placeholderStatus !== "final" && (scope === null || scope.has(i.id)));
  const inRunIds = new Set(inRun.map((i) => i.id));
  const others = open.filter((i) => i.merchantKind === "amazon" && i.placeholderStatus !== "final" && !inRunIds.has(i.id));

  const since = addDays(ctx.today, -(settings.amazonWindowDays + 30));
  const txns = await getCachedTxns(db, userId, planId, { sinceDate: since, includeDeleted: true });
  // Placeholders of long-lived (extended) intents can be older than the window: load them by id.
  const have = new Set(txns.map((t) => t.id));
  const missing = inRun.map((i) => i.placeholderTxnId).filter((id): id is string => id !== null && !have.has(id));
  if (missing.length) txns.push(...(await getCachedTxns(db, userId, planId, { ids: missing, includeDeleted: true })));

  const excluded = await excludedTxnIds(db, userId, planId);
  for (const i of inRun) if (i.placeholderTxnId) excluded.delete(i.placeholderTxnId);

  return {
    today: ctx.today, settings, decimalDigits: ctx.currency.decimalDigits,
    intents: inRun, otherOpenAmazonIntents: others, txns, excluded,
    uncategorizedIds: await uncategorizedIds(db, userId, planId),
    categoryNames: await categoryNames(db, userId, planId),
  };
}

// ynab/sync.ts — WP3 (DESIGN §8.3, §10.11 "Sync details").
import { and, eq, inArray, lt } from "drizzle-orm";
import { addDays, todayIn } from "../../shared/dates";
import { syncState, ynabAccounts, ynabCategories, ynabCategoryGroups, ynabPayees, ynabTransactions } from "../db/schema";
import type { BatchItem, DB } from "../env";
import { upsertCatalogStmts, upsertTxnsStmts } from "./cache";
import type { YnabClient } from "./client";
import type { YnabTxn } from "./types";

export interface SyncDelta { initial: boolean; changedTxnIds: string[]; deletedTxnIds: string[]; serverKnowledge: number }

/** Rolling cache window for the initial sync (§5 ynab_transactions). */
export const SYNC_WINDOW_DAYS = 120;
/** Delta syncs prune cached txns older than this (window + margin for long-lived intents). */
export const PRUNE_AFTER_DAYS = 180;
/** Statements per db.batch() call (keeps each batch well inside D1 limits). */
const BATCH_SIZE = 50;

async function runBatches(db: DB, stmts: BatchItem<"sqlite">[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    const part = stmts.slice(i, i + BATCH_SIZE);
    const [first, ...rest] = part;
    if (first) await db.batch([first, ...rest]);
  }
}

function deltaIds(txns: YnabTxn[]): Pick<SyncDelta, "changedTxnIds" | "deletedTxnIds"> {
  return {
    changedTxnIds: txns.filter((t) => !t.deleted).map((t) => t.id),
    deletedTxnIds: txns.filter((t) => t.deleted).map((t) => t.id),
  };
}

/** Caller must hold the user lock (withUserLock). Upserts groups, categories, accounts, payees, then txns
 *  (txn payeeName resolved from the payee cache, see YnabTxn note). */
export async function syncPlan(env: Env, db: DB, client: YnabClient, userId: string, planId: string): Promise<SyncDelta> {
  void env; // part of the frozen signature; nothing env-specific is needed here
  const now = Date.now();
  await db.insert(syncState).values({ userId, planId }).onConflictDoNothing();
  const state = await db.select({ k: syncState.serverKnowledge }).from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.planId, planId))).get();
  const stateWhere = and(eq(syncState.userId, userId), eq(syncState.planId, planId));
  const today = todayIn("UTC", new Date(now));

  if (state?.k === null || state?.k === undefined) {
    // ── initial sync: 5 requests ──
    const currency = await client.getPlanSettings(planId);
    const cats = await client.getCategories(planId);
    const accts = await client.getAccounts(planId);
    const payees = await client.getPayees(planId);
    const txns = await client.getTransactionsSince(planId, addDays(today, -SYNC_WINDOW_DAYS));
    // Knowledge values may be per resource (spike S4): the minimum is always safe to resume from.
    const k = Math.min(cats.serverKnowledge, accts.serverKnowledge, payees.serverKnowledge, txns.serverKnowledge);

    const stmts: BatchItem<"sqlite">[] = [
      // A (re)initialised plan starts from a clean cache.
      db.delete(ynabTransactions).where(and(eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId))),
      db.delete(ynabCategories).where(and(eq(ynabCategories.userId, userId), eq(ynabCategories.planId, planId))),
      db.delete(ynabCategoryGroups).where(and(eq(ynabCategoryGroups.userId, userId), eq(ynabCategoryGroups.planId, planId))),
      db.delete(ynabAccounts).where(and(eq(ynabAccounts.userId, userId), eq(ynabAccounts.planId, planId))),
      db.delete(ynabPayees).where(and(eq(ynabPayees.userId, userId), eq(ynabPayees.planId, planId))),
      ...upsertCatalogStmts(db, userId, planId, { groups: cats.groups, categories: cats.items, accounts: accts.items, payees: payees.items }),
      ...upsertTxnsStmts(db, userId, planId, txns.items, now),
    ];
    await runBatches(db, stmts);
    // Knowledge last: a crash before this line simply re-runs the initial sync.
    await db.update(syncState).set({
      serverKnowledge: k, lastSyncAt: now, currencyIso: currency.isoCode, currencyDecimals: currency.decimalDigits,
    }).where(stateWhere);
    return { initial: true, ...deltaIds(txns.items), serverKnowledge: k };
  }

  // ── delta sync: 1 request ──
  const d = await client.getPlanDelta(planId, state.k);

  // Fill payee names the delta's TransactionSummary lacks: delta payees first, then the cache.
  const missing = [...new Set(d.transactions.filter((t) => t.payeeName === null && t.payeeId !== null).map((t) => t.payeeId as string))];
  const names = new Map(d.payees.map((p) => [p.id, p.name]));
  const toLookup = missing.filter((id) => !names.has(id));
  for (let i = 0; i < toLookup.length; i += 90) {
    const rows = await db.select({ id: ynabPayees.id, name: ynabPayees.name }).from(ynabPayees)
      .where(and(eq(ynabPayees.userId, userId), inArray(ynabPayees.id, toLookup.slice(i, i + 90)))).all();
    for (const r of rows) names.set(r.id, r.name);
  }
  // A changed parent whose subtransactions did not change arrives without them: keep a cached split flag.
  const ids = d.transactions.map((t) => t.id);
  const cachedSplit = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db.select({ id: ynabTransactions.id }).from(ynabTransactions)
      .where(and(eq(ynabTransactions.userId, userId), inArray(ynabTransactions.id, ids.slice(i, i + 90)), eq(ynabTransactions.isSplit, true))).all();
    for (const r of rows) cachedSplit.add(r.id);
  }
  const txns = d.transactions.map((t): YnabTxn => ({
    ...t,
    payeeName: t.payeeName ?? (t.payeeId ? (names.get(t.payeeId) ?? null) : null),
    isSplit: t.isSplit || cachedSplit.has(t.id),
  }));

  const stmts: BatchItem<"sqlite">[] = [
    // Prune first: an old txn that changed in this delta is still upserted and goes in a later prune.
    db.delete(ynabTransactions).where(and(
      eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId), lt(ynabTransactions.date, addDays(today, -PRUNE_AFTER_DAYS)),
    )),
    ...upsertCatalogStmts(db, userId, planId, { groups: d.categoryGroups, categories: d.categories, accounts: d.accounts, payees: d.payees }, { keepSortIndex: true }),
    ...upsertTxnsStmts(db, userId, planId, txns, now),
  ];
  await runBatches(db, stmts);
  await db.update(syncState).set({ serverKnowledge: d.serverKnowledge, lastSyncAt: now }).where(stateWhere);
  return { initial: false, ...deltaIds(txns), serverKnowledge: d.serverKnowledge };
}

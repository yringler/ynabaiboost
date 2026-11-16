// ynab/cache.ts — WP3 (DESIGN §8.3, §5). Cache queries, upserts and toTxnView.
// Effective category flags are computed at query time: hidden = c.hidden OR g.hidden;
// internal = g.name = 'Internal Master Category'; cc_payment = g.name = 'Credit Card Payments' (spike S1).
import { and, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { payeeSimilarity } from "../../shared/payee";
import type { Account, Category, CurrencyFormat, Payee, TxnView } from "../../shared/schemas";
import {
  matches, syncState, ynabAccounts, ynabCategories, ynabCategoryGroups, ynabPayees, ynabTransactions,
} from "../db/schema";
import type { BatchItem, DB } from "../env";
import type { CachedAccount, CachedCategory, CachedCategoryGroup, CachedPayee, YnabTxn } from "./types";

export const INTERNAL_GROUP_NAME = "Internal Master Category";
export const CC_PAYMENT_GROUP_NAME = "Credit Card Payments";
export const UNCATEGORIZED_NAME = "Uncategorized";
/** YNAB system payees that are never useful as suggestions. */
const SYSTEM_PAYEES = ["Starting Balance", "Manual Balance Adjustment", "Reconciliation Balance Adjustment"];

/** D1 allows at most 100 bound parameters per statement. */
const D1_MAX_PARAMS = 100;
const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** `SET col = excluded.col` for each property (multi-row upserts). */
function excludedSet<T extends SQLiteTable>(table: T, props: (keyof T["_"]["columns"] & string)[]): Record<string, SQL> {
  const cols = table as unknown as Record<string, SQLiteColumn>;
  const set: Record<string, SQL> = {};
  for (const p of props) {
    const col = cols[p];
    if (col) set[p] = sql.raw(`excluded."${col.name}"`);
  }
  return set;
}

// ── row mappers ──────────────────────────────────────────────────────────────

type TxnRow = typeof ynabTransactions.$inferSelect;
export function rowToTxn(r: TxnRow): YnabTxn {
  return {
    id: r.id, planId: r.planId, date: r.date, amount: r.amount,
    payeeId: r.payeeId, payeeName: r.payeeName,
    importPayeeName: r.importPayeeName, importPayeeNameOriginal: r.importPayeeNameOriginal,
    accountId: r.accountId, categoryId: r.categoryId, memo: r.memo,
    cleared: r.cleared, approved: r.approved, flagColor: r.flagColor,
    importId: r.importId, matchedTransactionId: r.matchedTransactionId, transferAccountId: r.transferAccountId,
    isSplit: r.isSplit, deleted: r.deleted,
  };
}

// ── upserts ──────────────────────────────────────────────────────────────────

const TXN_UPDATE_PROPS = [
  "planId", "date", "amount", "payeeId", "payeeName", "importPayeeName", "importPayeeNameOriginal", "accountId",
  "categoryId", "memo", "cleared", "approved", "flagColor", "importId", "matchedTransactionId", "transferAccountId",
  "isSplit", "deleted", "updatedAt",
] as const;

export function upsertTxnsStmts(db: DB, userId: string, planId: string, txns: YnabTxn[], now: number = Date.now()): BatchItem<"sqlite">[] {
  const rows = txns.map((t) => ({
    userId, planId, id: t.id, date: t.date, amount: t.amount,
    payeeId: t.payeeId, payeeName: t.payeeName,
    importPayeeName: t.importPayeeName, importPayeeNameOriginal: t.importPayeeNameOriginal,
    accountId: t.accountId, categoryId: t.categoryId, memo: t.memo, cleared: t.cleared, approved: t.approved,
    flagColor: t.flagColor, importId: t.importId, matchedTransactionId: t.matchedTransactionId,
    transferAccountId: t.transferAccountId, isSplit: t.isSplit, deleted: t.deleted, updatedAt: now,
  }));
  const perStmt = Math.floor(D1_MAX_PARAMS / 22);
  return chunk(rows, perStmt).map((part) =>
    db.insert(ynabTransactions).values(part).onConflictDoUpdate({
      target: [ynabTransactions.userId, ynabTransactions.id],
      set: excludedSet(ynabTransactions, [...TXN_UPDATE_PROPS]),
    }),
  );
}

/** Upserts for category groups, categories, accounts and payees (in that order).
 *  `keepSortIndex`: on a delta, keep the stored sort_index of existing categories (a delta has no global order). */
export function upsertCatalogStmts(
  db: DB, userId: string, planId: string,
  data: { groups: CachedCategoryGroup[]; categories: CachedCategory[]; accounts: CachedAccount[]; payees: CachedPayee[] },
  opts: { keepSortIndex?: boolean } = {},
): BatchItem<"sqlite">[] {
  const out: BatchItem<"sqlite">[] = [];
  for (const part of chunk(data.groups, Math.floor(D1_MAX_PARAMS / 6))) {
    out.push(db.insert(ynabCategoryGroups)
      .values(part.map((g) => ({ userId, planId, id: g.id, name: g.name, hidden: g.hidden, deleted: g.deleted })))
      .onConflictDoUpdate({ target: [ynabCategoryGroups.userId, ynabCategoryGroups.id], set: excludedSet(ynabCategoryGroups, ["planId", "name", "hidden", "deleted"]) }));
  }
  const catProps: ("planId" | "groupId" | "name" | "hidden" | "deleted" | "sortIndex")[] =
    opts.keepSortIndex ? ["planId", "groupId", "name", "hidden", "deleted"] : ["planId", "groupId", "name", "hidden", "deleted", "sortIndex"];
  for (const part of chunk(data.categories, Math.floor(D1_MAX_PARAMS / 8))) {
    out.push(db.insert(ynabCategories)
      .values(part.map((c) => ({
        userId, planId, id: c.id, groupId: c.groupId, name: c.name, hidden: c.hidden, deleted: c.deleted,
        // new categories arriving in a delta sort after the initially synced ones
        sortIndex: opts.keepSortIndex ? 1_000_000 + c.sortIndex : c.sortIndex,
      })))
      .onConflictDoUpdate({ target: [ynabCategories.userId, ynabCategories.id], set: excludedSet(ynabCategories, catProps) }));
  }
  for (const part of chunk(data.accounts, Math.floor(D1_MAX_PARAMS / 9))) {
    out.push(db.insert(ynabAccounts)
      .values(part.map((a) => ({
        userId, planId, id: a.id, name: a.name, type: a.type, onBudget: a.onBudget,
        directImportLinked: a.directImportLinked, closed: a.closed, deleted: a.deleted,
      })))
      .onConflictDoUpdate({
        target: [ynabAccounts.userId, ynabAccounts.id],
        set: excludedSet(ynabAccounts, ["planId", "name", "type", "onBudget", "directImportLinked", "closed", "deleted"]),
      }));
  }
  for (const part of chunk(data.payees, Math.floor(D1_MAX_PARAMS / 6))) {
    out.push(db.insert(ynabPayees)
      .values(part.map((p) => ({ userId, planId, id: p.id, name: p.name, transferAccountId: p.transferAccountId, deleted: p.deleted })))
      .onConflictDoUpdate({ target: [ynabPayees.userId, ynabPayees.id], set: excludedSet(ynabPayees, ["planId", "name", "transferAccountId", "deleted"]) }));
  }
  return out;
}

// ── catalog queries ──────────────────────────────────────────────────────────

export async function getCurrency(db: DB, userId: string, planId: string): Promise<CurrencyFormat & { planName: string | null }> {
  const row = await db.select({ iso: syncState.currencyIso, dec: syncState.currencyDecimals, name: syncState.planName })
    .from(syncState).where(and(eq(syncState.userId, userId), eq(syncState.planId, planId))).get();
  return { isoCode: row?.iso ?? "USD", decimalDigits: row?.dec ?? 2, planName: row?.name ?? null };
}

/** Category usable for new money movements: not deleted, not hidden (own or group), not internal, not CC payment. */
const selectableCond = () => and(
  eq(ynabCategories.deleted, false), eq(ynabCategoryGroups.deleted, false),
  eq(ynabCategories.hidden, false), eq(ynabCategoryGroups.hidden, false),
  sql`${ynabCategoryGroups.name} NOT IN (${INTERNAL_GROUP_NAME}, ${CC_PAYMENT_GROUP_NAME})`,
);
const groupJoin = and(eq(ynabCategoryGroups.userId, ynabCategories.userId), eq(ynabCategoryGroups.id, ynabCategories.groupId));

/** JOIN groups; !deleted, !(c.hidden||g.hidden), !internal, !ccPayment; sorted */
export async function getSelectableCategories(db: DB, userId: string, planId: string): Promise<Category[]> {
  return db.select({ id: ynabCategories.id, groupId: ynabCategories.groupId, groupName: ynabCategoryGroups.name, name: ynabCategories.name })
    .from(ynabCategories)
    .innerJoin(ynabCategoryGroups, groupJoin)
    .where(and(eq(ynabCategories.userId, userId), eq(ynabCategories.planId, planId), selectableCond()))
    .orderBy(ynabCategories.sortIndex, ynabCategoryGroups.name, ynabCategories.name)
    .all();
}

/** !deleted, !closed; includes directImportLinked */
export async function getAccounts(db: DB, userId: string, planId: string): Promise<Account[]> {
  return db.select({
    id: ynabAccounts.id, name: ynabAccounts.name, type: ynabAccounts.type, onBudget: ynabAccounts.onBudget,
    closed: ynabAccounts.closed, directImportLinked: ynabAccounts.directImportLinked,
  })
    .from(ynabAccounts)
    .where(and(eq(ynabAccounts.userId, userId), eq(ynabAccounts.planId, planId), eq(ynabAccounts.deleted, false), eq(ynabAccounts.closed, false)))
    .orderBy(desc(ynabAccounts.onBudget), ynabAccounts.name)
    .all();
}

const payeeBaseCond = (userId: string, planId: string) => and(
  eq(ynabPayees.userId, userId), eq(ynabPayees.planId, planId), eq(ynabPayees.deleted, false),
  isNull(ynabPayees.transferAccountId), sql`${ynabPayees.name} NOT IN (${sql.join(SYSTEM_PAYEES.map((n) => sql`${n}`), sql`, `)})`,
);

/** !deleted, non-transfer; for bestPayeeMatch */
export async function getAllPayees(db: DB, userId: string, planId: string): Promise<Payee[]> {
  return db.select({ id: ynabPayees.id, name: ynabPayees.name }).from(ynabPayees)
    .where(payeeBaseCond(userId, planId)).orderBy(ynabPayees.name).all();
}

/** Payees ranked by number of cached (non-deleted) transactions, most recent use breaking ties. */
export async function getTopPayees(db: DB, userId: string, planId: string, limit: number): Promise<Payee[]> {
  const n = sql<number>`COUNT(${ynabTransactions.id})`;
  const rows = await db.select({ id: ynabPayees.id, name: ynabPayees.name, n })
    .from(ynabPayees)
    .leftJoin(ynabTransactions, and(
      eq(ynabTransactions.userId, ynabPayees.userId), eq(ynabTransactions.payeeId, ynabPayees.id), eq(ynabTransactions.deleted, false),
    ))
    .where(payeeBaseCond(userId, planId))
    .groupBy(ynabPayees.id, ynabPayees.name)
    .orderBy(desc(n), desc(sql`MAX(${ynabTransactions.date})`), ynabPayees.name)
    .limit(limit)
    .all();
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Selectable categories by number of uses in the cached window, most-used first. */
export async function getRecentCategoryIds(db: DB, userId: string, planId: string, limit: number): Promise<string[]> {
  const n = sql<number>`COUNT(*)`;
  const rows = await db.select({ id: ynabTransactions.categoryId, n })
    .from(ynabTransactions)
    .innerJoin(ynabCategories, and(eq(ynabCategories.userId, ynabTransactions.userId), eq(ynabCategories.id, ynabTransactions.categoryId)))
    .innerJoin(ynabCategoryGroups, groupJoin)
    .where(and(eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId), eq(ynabTransactions.deleted, false), selectableCond()))
    .groupBy(ynabTransactions.categoryId)
    .orderBy(desc(n), desc(sql`MAX(${ynabTransactions.date})`))
    .limit(limit)
    .all();
  return rows.flatMap((r) => (r.id ? [r.id] : []));
}

// ── transactions ─────────────────────────────────────────────────────────────

export async function getCachedTxns(
  db: DB, userId: string, planId: string, q: { sinceDate?: string; ids?: string[]; includeDeleted?: boolean },
): Promise<YnabTxn[]> {
  const base = (extra?: SQL) => and(
    eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId),
    q.sinceDate ? gte(ynabTransactions.date, q.sinceDate) : undefined,
    q.includeDeleted ? undefined : eq(ynabTransactions.deleted, false),
    extra,
  );
  const order = [desc(ynabTransactions.date), ynabTransactions.id] as const;
  if (q.ids !== undefined) {
    if (q.ids.length === 0) return [];
    const parts = await Promise.all(chunk([...new Set(q.ids)], 90).map((ids) =>
      db.select().from(ynabTransactions).where(base(inArray(ynabTransactions.id, ids))).orderBy(...order).all()));
    return parts.flat().sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date))).map(rowToTxn);
  }
  const rows = await db.select().from(ynabTransactions).where(base()).orderBy(...order).all();
  return rows.map(rowToTxn);
}

/** Ids of YNAB's internal "Uncategorized" category (normally one) for this plan. */
export async function getUncategorizedIds(db: DB, userId: string, planId: string): Promise<Set<string>> {
  const rows = await db.select({ id: ynabCategories.id }).from(ynabCategories)
    .innerJoin(ynabCategoryGroups, groupJoin)
    .where(and(
      eq(ynabCategories.userId, userId), eq(ynabCategories.planId, planId),
      eq(ynabCategories.name, UNCATEGORIZED_NAME), eq(ynabCategoryGroups.name, INTERNAL_GROUP_NAME),
    )).all();
  return new Set(rows.map((r) => r.id));
}

/** Per payee id: categories it was used with (approved, non-split, categorized, not internal), most-used first. */
export async function payeeCategoryHistory(db: DB, userId: string, planId: string, payeeIds: string[]): Promise<Map<string, { categoryId: string; count: number }[]>> {
  const out = new Map<string, { categoryId: string; count: number }[]>();
  const ids = [...new Set(payeeIds)];
  if (ids.length === 0) return out;
  const n = sql<number>`COUNT(*)`;
  for (const part of chunk(ids, 90)) {
    const rows = await db.select({ payeeId: ynabTransactions.payeeId, categoryId: ynabTransactions.categoryId, n })
      .from(ynabTransactions)
      .innerJoin(ynabCategories, and(eq(ynabCategories.userId, ynabTransactions.userId), eq(ynabCategories.id, ynabTransactions.categoryId)))
      .innerJoin(ynabCategoryGroups, groupJoin)
      .where(and(
        eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId), inArray(ynabTransactions.payeeId, part),
        eq(ynabTransactions.deleted, false), eq(ynabTransactions.approved, true), eq(ynabTransactions.isSplit, false),
        sql`${ynabCategoryGroups.name} <> ${INTERNAL_GROUP_NAME}`,
      ))
      .groupBy(ynabTransactions.payeeId, ynabTransactions.categoryId)
      .all();
    for (const r of rows) {
      if (!r.payeeId || !r.categoryId) continue;
      const list = out.get(r.payeeId) ?? [];
      list.push({ categoryId: r.categoryId, count: Number(r.n) });
      out.set(r.payeeId, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => b.count - a.count || a.categoryId.localeCompare(b.categoryId));
  return out;
}

const SIMILAR_PAYEE = 0.8;
const SCAN_LIMIT = 500;
const txnNames = (t: { payeeName: string | null; importPayeeName: string | null; importPayeeNameOriginal: string | null }) =>
  [t.importPayeeNameOriginal, t.importPayeeName, t.payeeName];

/** Account of the most recent non-transfer txn at a similar payee (payeeSimilarity ≥ 0.8), on an open account. */
export async function lastAccountForPayee(db: DB, userId: string, planId: string, payee: string): Promise<string | null> {
  const rows = await db.select({
    accountId: ynabTransactions.accountId, payeeName: ynabTransactions.payeeName,
    importPayeeName: ynabTransactions.importPayeeName, importPayeeNameOriginal: ynabTransactions.importPayeeNameOriginal,
  })
    .from(ynabTransactions)
    .innerJoin(ynabAccounts, and(eq(ynabAccounts.userId, ynabTransactions.userId), eq(ynabAccounts.id, ynabTransactions.accountId)))
    .where(and(
      eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId), eq(ynabTransactions.deleted, false),
      isNull(ynabTransactions.transferAccountId), eq(ynabAccounts.deleted, false), eq(ynabAccounts.closed, false),
    ))
    .orderBy(desc(ynabTransactions.date), desc(ynabTransactions.updatedAt))
    .limit(SCAN_LIMIT)
    .all();
  for (const r of rows) if (payeeSimilarity(payee, txnNames(r)) >= SIMILAR_PAYEE) return r.accountId;
  return null;
}

/** Category of the most recent matched (or approved, categorized) outflow at a similar payee (≥ 0.8). For inflow suggestions (§9.5). */
export async function lastOutflowCategoryForPayee(db: DB, userId: string, planId: string, payeeNames: (string | null)[]): Promise<string | null> {
  const names = payeeNames.filter((n): n is string => n !== null && n.trim() !== "");
  if (names.length === 0) return null;
  const matched = db.select({ id: matches.ynabTxnId }).from(matches).where(and(eq(matches.userId, userId), eq(matches.state, "applied")));
  const rows = await db.select({
    categoryId: ynabTransactions.categoryId, payeeName: ynabTransactions.payeeName,
    importPayeeName: ynabTransactions.importPayeeName, importPayeeNameOriginal: ynabTransactions.importPayeeNameOriginal,
  })
    .from(ynabTransactions)
    .innerJoin(ynabCategories, and(eq(ynabCategories.userId, ynabTransactions.userId), eq(ynabCategories.id, ynabTransactions.categoryId)))
    .innerJoin(ynabCategoryGroups, groupJoin)
    .where(and(
      eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId), eq(ynabTransactions.deleted, false),
      lt(ynabTransactions.amount, 0), eq(ynabTransactions.isSplit, false), isNull(ynabTransactions.transferAccountId),
      sql`(${ynabTransactions.approved} = 1 OR ${ynabTransactions.id} IN ${matched})`,
      selectableCond(),
    ))
    .orderBy(desc(ynabTransactions.date), desc(ynabTransactions.updatedAt))
    .limit(SCAN_LIMIT)
    .all();
  for (const r of rows) {
    const theirs = txnNames(r);
    if (names.some((n) => payeeSimilarity(n, theirs) >= SIMILAR_PAYEE)) return r.categoryId;
  }
  return null;
}

/** null or internal "Uncategorized" */
export async function isUncategorized(db: DB, userId: string, planId: string, categoryId: string | null): Promise<boolean> {
  if (categoryId === null) return true;
  return (await getUncategorizedIds(db, userId, planId)).has(categoryId);
}

export function toTxnView(t: YnabTxn, accountsById: Map<string, Account>, uncategorizedIds: Set<string>): TxnView {
  return {
    id: t.id,
    date: t.date,
    amount: t.amount,
    payeeName: t.payeeName,
    importPayeeName: t.importPayeeNameOriginal ?? t.importPayeeName,
    accountId: t.accountId,
    accountName: accountsById.get(t.accountId)?.name ?? "Unknown account",
    categoryId: t.categoryId !== null && uncategorizedIds.has(t.categoryId) ? null : t.categoryId,
    memo: t.memo,
    approved: t.approved,
    cleared: t.cleared,
    isSplit: t.isSplit,
    isTransfer: t.transferAccountId !== null,
    isImported: t.importId !== null,
  };
}

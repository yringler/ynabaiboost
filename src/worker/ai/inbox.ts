// ai/inbox.ts — WP4 (DESIGN §8.4, §9.1, §9.5). Inbox selection, rule-based suggestions and Claude batches.
//
// Selection (§9.5): cached txns with deleted=0, no transfer, date ≥ today−60, (approved=0 OR uncategorized),
// not in excludedTxnIds (WP5), and not dismissed. A dismissal hides the txn "until the txn changes": the
// dismissal stamps inbox_suggestions.created_at, and the txn reappears once ynab_transactions.updated_at (set by
// every cache upsert of a changed txn) is newer. Split parents are left out entirely: their category is null by
// design, and the app never edits an existing split (§16).
//
// Suggestion sources, in this order (Claude only for the rest): ynab_existing, refund history, dominant payee
// history (computed live on every read), then the stored Claude suggestion from inbox_suggestions.
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { addDays } from "../../shared/dates";
import type Anthropic from "@anthropic-ai/sdk";
import type { Category, InboxItem, InboxSuggestion } from "../../shared/schemas";
import { getSettings } from "../auth/settings";
import { inboxSuggestions, ynabAccounts, ynabCategories, ynabCategoryGroups, ynabTransactions } from "../db/schema";
import type { DB } from "../env";
import { excludedTxnIds, possibleIntentFor } from "../engine/load";
import { AppError } from "../lib/errors";
import {
  getAccounts, getCurrency, getSelectableCategories, getTopPayees, lastOutflowCategoryForPayee, payeeCategoryHistory, toTxnView,
} from "../ynab/cache";
import type { YnabTxn } from "../ynab/types";
import { callStructured, getClaude } from "./claude";
import { safeTodayIn, type AiCtx } from "./parse";
import { CATALOG_PAYEES, INBOX_SYSTEM, renderCatalog, renderInboxUserTurn, type InboxLineInput } from "./prompts";
import { InboxOut } from "./schemas";

export const INBOX_WINDOW_DAYS = 60;
export const INBOX_LIST_MAX = 100;
export const INBOX_BATCH = 12;
/** §9.1 inbox call policy (effort comes from the caller). */
export const INBOX_CALL = { maxTokens: 16000, timeoutMs: 90_000, maxRetries: 1 } as const;
/** Dominant payee history: ≥ 3 uses and ≥ 80 % of them (§9.5). */
export const HISTORY_MIN_USES = 3;
export const HISTORY_MIN_SHARE = 0.8;
const HISTORY_REFS_PER_TXN = 3;
const REASON_MAX = 200;

// YNAB's internal "Uncategorized" category (same definition as ynab/cache.ts isUncategorized).
const INTERNAL_GROUP = "Internal Master Category";
const UNCATEGORIZED = "Uncategorized";

type TxnRow = typeof ynabTransactions.$inferSelect;
type SuggestionRow = typeof inboxSuggestions.$inferSelect;
type Suggestion = InboxSuggestion;

export interface InboxCandidate { txn: YnabTxn; updatedAt: number; stored: SuggestionRow | null }

function rowToTxn(r: TxnRow): YnabTxn {
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

/** Ids of the plan's internal "Uncategorized" category (normally one). */
export async function uncategorizedIds(db: DB, userId: string, planId: string): Promise<Set<string>> {
  const rows = await db.select({ id: ynabCategories.id })
    .from(ynabCategories)
    .innerJoin(ynabCategoryGroups, and(eq(ynabCategoryGroups.userId, ynabCategories.userId), eq(ynabCategoryGroups.id, ynabCategories.groupId)))
    .where(and(
      eq(ynabCategories.userId, userId), eq(ynabCategories.planId, planId),
      eq(ynabCategories.name, UNCATEGORIZED), eq(ynabCategoryGroups.name, INTERNAL_GROUP),
    ))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** True when a stored dismissal still applies (the txn has not changed since). */
const isDismissed = (c: { updatedAt: number; stored: SuggestionRow | null }) =>
  c.stored?.status === "dismissed" && c.updatedAt <= c.stored.createdAt;

/** §9.5 selection, newest first. Not limited; callers slice. */
export async function selectInbox(db: DB, userId: string, planId: string, today: string): Promise<{ candidates: InboxCandidate[]; uncategorized: Set<string> }> {
  const since = addDays(today, -INBOX_WINDOW_DAYS);
  const [uncategorized, excluded] = await Promise.all([
    uncategorizedIds(db, userId, planId),
    excludedTxnIds(db, userId, planId),
  ]);
  const uncatSql = uncategorized.size > 0
    ? sql`${ynabTransactions.categoryId} IN (${sql.join([...uncategorized].map((id) => sql`${id}`), sql`, `)})`
    : sql`0`;
  const rows = await db.select({ t: ynabTransactions, s: inboxSuggestions })
    .from(ynabTransactions)
    .leftJoin(inboxSuggestions, and(eq(inboxSuggestions.userId, ynabTransactions.userId), eq(inboxSuggestions.ynabTxnId, ynabTransactions.id)))
    .where(and(
      eq(ynabTransactions.userId, userId), eq(ynabTransactions.planId, planId),
      eq(ynabTransactions.deleted, false), isNull(ynabTransactions.transferAccountId), eq(ynabTransactions.isSplit, false),
      gte(ynabTransactions.date, since),
      // Tracking (off-budget) accounts take no categories: their txns never belong in the inbox.
      sql`NOT EXISTS (SELECT 1 FROM ${ynabAccounts} WHERE ${ynabAccounts.userId} = ${ynabTransactions.userId}
        AND ${ynabAccounts.id} = ${ynabTransactions.accountId} AND ${ynabAccounts.onBudget} = 0)`,
      or(eq(ynabTransactions.approved, false), isNull(ynabTransactions.categoryId), uncatSql),
    ))
    .orderBy(desc(ynabTransactions.date), ynabTransactions.id)
    .all();
  const candidates = rows
    .map((r) => ({ txn: rowToTxn(r.t), updatedAt: r.t.updatedAt, stored: r.s }))
    .filter((c) => !excluded.has(c.txn.id) && !isDismissed(c));
  return { candidates, uncategorized };
}

/** Rule-based suggestions (§9.5), before Claude: ynab_existing, refund history, dominant payee history. */
export async function ruleSuggestions(
  db: DB, userId: string, planId: string, txns: YnabTxn[], uncategorized: Set<string>, categoriesById: Map<string, Category>,
): Promise<Map<string, Suggestion>> {
  const out = new Map<string, Suggestion>();
  const rest: YnabTxn[] = [];
  for (const t of txns) {
    if (!t.approved && t.categoryId !== null && !uncategorized.has(t.categoryId)) {
      out.set(t.id, { categoryId: t.categoryId, confidence: "high", source: "ynab_existing", reason: "Category set by YNAB" });
    } else {
      rest.push(t);
    }
  }

  const afterRefunds: YnabTxn[] = [];
  for (const t of rest) {
    if (t.amount > 0) {
      const cat = await lastOutflowCategoryForPayee(db, userId, planId, [t.payeeName, t.importPayeeName, t.importPayeeNameOriginal]);
      const c = cat === null ? undefined : categoriesById.get(cat);
      if (c) {
        out.set(t.id, { categoryId: c.id, confidence: "high", source: "history", reason: clipReason(`Refund: last purchase here was ${c.name}`) });
        continue;
      }
    }
    afterRefunds.push(t);
  }

  const payeeIds = afterRefunds.flatMap((t) => (t.payeeId ? [t.payeeId] : []));
  const history = await payeeCategoryHistory(db, userId, planId, payeeIds);
  for (const t of afterRefunds) {
    const list = t.payeeId ? history.get(t.payeeId) : undefined;
    const top = list?.[0];
    if (!list || !top) continue;
    const total = list.reduce((s, h) => s + h.count, 0);
    const c = categoriesById.get(top.categoryId);
    if (c && top.count >= HISTORY_MIN_USES && top.count / total >= HISTORY_MIN_SHARE) {
      out.set(t.id, { categoryId: c.id, confidence: "high", source: "history", reason: clipReason(`Usually ${c.name} (${top.count} of ${total})`) });
    }
  }
  return out;
}

const clipReason = (s: string) => (s.length > REASON_MAX ? s.slice(0, REASON_MAX) : s);

function storedSuggestion(row: SuggestionRow | null, categoriesById: Map<string, Category>): Suggestion | null {
  if (!row || row.status !== "suggested") return null;
  // A category that was hidden or deleted since is no longer offered.
  if (row.categoryId !== null && !categoriesById.has(row.categoryId)) return null;
  return { categoryId: row.categoryId, confidence: row.confidence, reason: row.reason, source: row.source };
}

/** Uses WP5 excludedTxnIds and WP5 possibleIntentFor (§9.5). */
export async function listInbox(ctx: AiCtx): Promise<InboxItem[]> {
  const { db, userId, planId } = ctx;
  const today = safeTodayIn(ctx.settings.timezone);
  const { candidates, uncategorized } = await selectInbox(db, userId, planId, today);
  const shown = candidates.slice(0, INBOX_LIST_MAX);
  if (shown.length === 0) return [];
  const txns = shown.map((c) => c.txn);
  const [accounts, categories] = await Promise.all([getAccounts(db, userId, planId), getSelectableCategories(db, userId, planId)]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const [rules, possible] = await Promise.all([
    ruleSuggestions(db, userId, planId, txns, uncategorized, categoriesById),
    possibleIntentFor(db, userId, planId, txns),
  ]);
  return shown.map((c) => ({
    transaction: toTxnView(c.txn, accountsById, uncategorized),
    suggestion: rules.get(c.txn.id) ?? storedSuggestion(c.stored, categoriesById),
    possibleIntent: possible.get(c.txn.id) ?? null,
  }));
}

export async function countInbox(db: DB, userId: string, planId: string): Promise<number> {
  const settings = await getSettings(db, userId);
  const { candidates } = await selectInbox(db, userId, planId, safeTodayIn(settings.timezone));
  return Math.min(candidates.length, INBOX_LIST_MAX);
}

/** Codes that mean "the user hasn't set Claude up": background suggestions silently do nothing. */
const NOT_SET_UP = new Set(["ai_consent_required", "anthropic_key_missing"]);

/** Fills inbox_suggestions for inbox txns lacking one. Returns #suggested. Silently returns 0 when no key/consent.
 *  Other Claude errors (ai_*, anthropic_key_invalid, anthropic_billing) are thrown after any rows from earlier
 *  batches are stored; the cycle records the code in SyncResult.errors and continues (§9.4). */
export async function suggestInboxCategories(ctx: AiCtx, opts: { max: number; effort: "low" | "medium" }): Promise<number> {
  const { db, userId, planId } = ctx;
  if (!ctx.settings.aiDataConsent || opts.max <= 0) return 0;
  const today = safeTodayIn(ctx.settings.timezone);
  const { candidates, uncategorized } = await selectInbox(db, userId, planId, today);
  const lacking = candidates.filter((c) => c.stored === null);
  if (lacking.length === 0) return 0;

  const [categories, accounts, topPayees, currency] = await Promise.all([
    getSelectableCategories(db, userId, planId),
    getAccounts(db, userId, planId),
    getTopPayees(db, userId, planId, CATALOG_PAYEES),
    getCurrency(db, userId, planId),
  ]);
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const rules = await ruleSuggestions(db, userId, planId, lacking.map((c) => c.txn), uncategorized, categoriesById);
  const todo = lacking.filter((c) => !rules.has(c.txn.id)).slice(0, opts.max).map((c) => c.txn);
  if (todo.length === 0 || categories.length === 0) return 0;

  let client: Anthropic;
  try {
    client = await getClaude(ctx.env, db, userId);
  } catch (e) {
    if (e instanceof AppError && NOT_SET_UP.has(e.code)) return 0;
    throw e;
  }

  const catalog = renderCatalog({ categories, accounts, payees: topPayees });
  // Cached across back-to-back batches: the catalog block is the only one with cache_control (§9.1).
  const system = [
    { type: "text" as const, text: INBOX_SYSTEM },
    { type: "text" as const, text: catalog.text, cache_control: { type: "ephemeral" as const } },
  ];
  const history = await payeeCategoryHistory(db, userId, planId, todo.flatMap((t) => (t.payeeId ? [t.payeeId] : [])));

  let written = 0;
  for (let i = 0; i < todo.length; i += INBOX_BATCH) {
    const batch = todo.slice(i, i + INBOX_BATCH);
    const byRef = new Map<string, YnabTxn>();
    const lines: InboxLineInput[] = batch.map((t, j) => {
      const ref = `t${j + 1}`;
      byRef.set(ref, t);
      const hist = (t.payeeId ? history.get(t.payeeId) ?? [] : [])
        .flatMap((h) => {
          const r = catalog.refByCategoryId.get(h.categoryId);
          return r ? [{ categoryRef: r, count: h.count }] : [];
        })
        .slice(0, HISTORY_REFS_PER_TXN);
      return {
        ref, date: t.date, amount: t.amount, payeeName: t.payeeName,
        bankName: t.importPayeeNameOriginal ?? t.importPayeeName,
        accountRef: catalog.refByAccountId.get(t.accountId) ?? null, memo: t.memo, history: hist,
      };
    });
    const out = await callStructured(client, {
      schema: InboxOut, system, user: renderInboxUserTurn(lines, currency.decimalDigits), effort: opts.effort, ...INBOX_CALL,
    });
    const now = Date.now();
    const seen = new Set<string>();
    const rows: (typeof inboxSuggestions.$inferInsert)[] = [];
    for (const s of out.suggestions) {
      const ref = s.txn_ref.trim();
      const t = byRef.get(ref);
      if (!t || seen.has(ref)) continue;                          // unknown or duplicate ref
      seen.add(ref);
      const category = s.category_ref === null ? undefined : catalog.categoryByRef.get(s.category_ref.trim());
      rows.push({
        userId, ynabTxnId: t.id, categoryId: category?.id ?? null,
        confidence: category ? s.confidence : "low",                 // unknown category refs are dropped
        reason: clipReason(s.reason.replace(/\s+/g, " ").trim()), source: "claude", status: "suggested", createdAt: now,
      });
    }
    if (rows.length > 0) {
      // A row that appeared meanwhile (e.g. a dismissal) wins.
      await db.insert(inboxSuggestions).values(rows).onConflictDoNothing();
      written += rows.length;
    }
  }
  return written;
}

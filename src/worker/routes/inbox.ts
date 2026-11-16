// routes/inbox.ts — WP4 (DESIGN §7, §9.5): /api/inbox, /api/inbox/suggest, /api/inbox/approve, /api/inbox/dismiss.
// Mounted at /api behind requireSession + requireAllowedUser (index.ts).
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { API } from "../../shared/api";
import { formatMilli } from "../../shared/money";
import type { Settings } from "../../shared/schemas";
import { getAnthropicKey } from "../auth/anthropicKey";
import { getSettings } from "../auth/settings";
import { listInbox, suggestInboxCategories } from "../ai/inbox";
import { inboxSuggestions, syncState } from "../db/schema";
import type { AppEnv, BatchItem, DB } from "../env";
import { excludedTxnIds } from "../engine/load";
import { auditStmt, toSnapshot } from "../lib/audit";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validate";
import { getAccounts, getCachedTxns, getCurrency, getSelectableCategories, upsertTxnsStmts } from "../ynab/cache";
import { createYnabClient } from "../ynab/client";
import type { TxnUpdate, YnabTxn } from "../ynab/types";

/** POST /api/inbox/suggest asks Claude for at most this many txns (§7). */
export const INTERACTIVE_SUGGEST_MAX = 25;

export const inboxRoutes = new Hono<AppEnv>();

async function planSettings(db: DB, userId: string): Promise<Settings & { planId: string }> {
  const settings = await getSettings(db, userId);
  if (!settings.planId) throw new AppError("no_plan_selected", "Choose a YNAB plan first");
  return { ...settings, planId: settings.planId };
}

inboxRoutes.get("/inbox", async (c) => {
  const { db, userId } = c.var;
  const settings = await planSettings(db, userId);
  const [items, state] = await Promise.all([
    listInbox({ env: c.env, db, userId, planId: settings.planId, settings }),
    db.select({ at: syncState.lastCycleAt }).from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.planId, settings.planId))).get(),
  ]);
  return c.json(API.inbox.res.parse({ items, lastSyncAt: state?.at ?? null }));
});

inboxRoutes.post("/inbox/suggest", async (c) => {
  const { db, userId } = c.var;
  const settings = await planSettings(db, userId);
  // Interactive: surface ai_consent_required / anthropic_key_missing instead of silently suggesting nothing.
  await getAnthropicKey(c.env, db, userId);
  const suggested = await suggestInboxCategories(
    { env: c.env, db, userId, planId: settings.planId, settings },
    { max: INTERACTIVE_SUGGEST_MAX, effort: "medium" },
  );
  return c.json(API.inboxSuggest.res.parse({ suggested }));
});

inboxRoutes.post("/inbox/approve", validate("json", API.inboxApprove.req), async (c) => {
  const { db, userId } = c.var;
  const settings = await planSettings(db, userId);
  const planId = settings.planId;
  const { items } = c.req.valid("json");

  // Last entry wins for a repeated id.
  const wanted = new Map<string, string>();
  for (const it of items) wanted.set(it.transactionId, it.categoryId);
  const ids = [...wanted.keys()];

  const [excluded, cached, categories, currency, accounts] = await Promise.all([
    excludedTxnIds(db, userId, planId),
    getCachedTxns(db, userId, planId, { ids }),
    getSelectableCategories(db, userId, planId),
    getCurrency(db, userId, planId),
    getAccounts(db, userId, planId),
  ]);
  const offBudget = new Set(accounts.filter((a) => !a.onBudget).map((a) => a.id));
  const cachedById = new Map(cached.map((t) => [t.id, t]));
  const categoriesById = new Map(categories.map((x) => [x.id, x]));

  const failed: { transactionId: string; message: string }[] = [];
  const updates: TxnUpdate[] = [];
  for (const [id, categoryId] of wanted) {
    const t = cachedById.get(id);
    const reason =
      !t ? "Transaction not found. Sync and try again."
      : excluded.has(id) ? "This transaction is linked to an intent or a review"
      : t.isSplit ? "Split transactions can only be edited in YNAB"
      : t.transferAccountId !== null ? "Transfers have no category"
      : offBudget.has(t.accountId) ? "Tracking account transactions have no category"
      : !categoriesById.has(categoryId) ? "That category is not available"
      : null;
    if (reason !== null || !t) {
      failed.push({ transactionId: id, message: reason ?? "Transaction not found" });
      continue;
    }
    const u: TxnUpdate = { id, categoryId, approved: true };
    if (settings.flagColor !== null && t.flagColor === null) u.flagColor = settings.flagColor; // never replace the user's flag
    updates.push(u);
  }
  if (updates.length === 0) return c.json(API.inboxApprove.res.parse({ approved: 0, failed }));

  // One bulk PATCH. A YNAB error fails the whole request (AppError via the client).
  const client = await createYnabClient(c.env, db, userId, "interactive");
  const updated = await client.updateTransactions(planId, updates);
  const updatedById = new Map(updated.map((t) => [t.id, t]));

  const now = Date.now();
  const stmts: BatchItem<"sqlite">[] = [...upsertTxnsStmts(db, userId, planId, updated, now)];
  const approvedIds: string[] = [];
  for (const u of updates) {
    const before = cachedById.get(u.id);
    const after = updatedById.get(u.id);
    if (!before || !after) {
      failed.push({ transactionId: u.id, message: "YNAB did not update this transaction" });
      continue;
    }
    approvedIds.push(u.id);
    stmts.push(auditStmt(db, {
      userId, actor: "user", action: "inbox_approved", ynabTxnId: u.id,
      summary: summary(after, categoriesById.get(u.categoryId ?? "")?.name ?? "a category", currency),
      before: toSnapshot(before), after: toSnapshot(after),
    }, now));
  }
  if (approvedIds.length > 0) {
    stmts.push(db.update(inboxSuggestions).set({ status: "applied" })
      .where(and(eq(inboxSuggestions.userId, userId), inArray(inboxSuggestions.ynabTxnId, approvedIds))));
  }
  const [first, ...rest] = stmts;
  if (first) await db.batch([first, ...rest]);
  return c.json(API.inboxApprove.res.parse({ approved: approvedIds.length, failed }));
});

function summary(t: YnabTxn, categoryName: string, currency: { isoCode: string; decimalDigits: number }): string {
  const who = t.payeeName ?? t.importPayeeNameOriginal ?? t.importPayeeName ?? "transaction";
  let amount: string;
  try {
    amount = formatMilli(t.amount, currency, "en-US");
  } catch {
    amount = (t.amount / 1000).toFixed(2);
  }
  return `Approved ${who} ${amount} as ${categoryName}`;
}

inboxRoutes.post("/inbox/dismiss", validate("json", API.inboxDismiss.req), async (c) => {
  const { db, userId } = c.var;
  const { transactionIds } = c.req.valid("json");
  const now = Date.now();
  // Stamping created_at with the dismissal time hides the txn until its cache row changes (§7, ai/inbox.ts).
  const rows = [...new Set(transactionIds)].map((id) => ({
    userId, ynabTxnId: id, categoryId: null, confidence: "low" as const, reason: "Dismissed",
    source: "claude" as const, status: "dismissed" as const, createdAt: now,
  }));
  // ≤ 50 rows × 8 columns exceeds D1's 100 bound parameters per statement: one statement per 12 rows.
  const stmts: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < rows.length; i += 12) {
    stmts.push(db.insert(inboxSuggestions).values(rows.slice(i, i + 12)).onConflictDoUpdate({
      target: [inboxSuggestions.userId, inboxSuggestions.ynabTxnId],
      set: { status: "dismissed", createdAt: now },
    }));
  }
  const [first, ...rest] = stmts;
  if (first) await db.batch([first, ...rest]);
  return c.json({ ok: true as const });
});

// services/intents.ts — the intent write paths (DESIGN §7, §10.7, §10.9) as plain functions, shared by
// routes/intents.ts (one HTTP route each) and the conversational-edit executor (services/edit.ts, §9.6), so both
// get the same placeholder updates, live untouched-placeholder guard, precision recomputation, locks and audit rows.
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { UpdateIntentReq } from "../../shared/api";
import { addDays, minDate, todayIn } from "../../shared/dates";
import { toYnabAmount } from "../../shared/money";
import { assessPrecision, precisionInfo, type OrderFacts, type PrecisionResult } from "../../shared/precision";
import type { InputMode, Intent, IntentCreate, Settings } from "../../shared/schemas";
import { getSettings } from "../auth/settings";
import { intentLines, intents } from "../db/schema";
import { allocate } from "../domain/allocate";
import { dateWindow } from "../domain/dates";
import { APPROX_PREFIX, memoTag, mergeMemo, stripApprox } from "../domain/memo";
import { appendNote, factsAfterEdit, storedFacts } from "../domain/note";
import { nudged } from "../domain/nudge";
import { toleranceFor } from "../domain/tolerance";
import { createPlaceholder, livePlaceholder, safeDeletePlaceholder } from "../engine/placeholders";
import { reconcileUser, type EngineCtx } from "../engine/reconcile";
import { detachIntentFromReviews } from "../engine/reviews";
import { getLinesOf, intentDto, intentDtos, isOpen, isUniqueViolation, requireIntent, runBatch } from "../engine/store";
import type { BatchItem, DB } from "../env";
import { withUserLock } from "../jobs/cycle";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { newId, newShortRef } from "../lib/ids";
import { getCurrency, upsertTxnsStmts } from "../ynab/cache";
import { createYnabClient, type YnabClient } from "../ynab/client";
import { syncPlan } from "../ynab/sync";
import type { TxnUpdate } from "../ynab/types";

/** How long intent creation waits for a cycle holding the user lock (§10.7). */
export const CREATE_LOCK_WAIT_MS = 5_000;

export interface Base { db: DB; userId: string; settings: Settings; planId: string; today: string }
type InputModeT = z.infer<typeof InputMode>;
export type IntentPatch = z.infer<typeof UpdateIntentReq>;

export async function loadBase(db: DB, userId: string): Promise<Base> {
  const settings = await getSettings(db, userId);
  if (!settings.planId) throw new AppError("no_plan_selected", "Choose a YNAB plan first");
  return { db, userId, settings, planId: settings.planId, today: todayIn(settings.timezone) };
}

/** Per-intent writes act on the intent's own plan, not the currently selected one (the user may have switched). */
export const forIntent = (b: Base, row: { planId: string }): Base => (row.planId === b.planId ? b : { ...b, planId: row.planId });

export async function engineCtx(env: Env, b: Base, client?: YnabClient): Promise<EngineCtx> {
  const { planName: _n, ...currency } = await getCurrency(b.db, b.userId, b.planId);
  return {
    env, db: b.db, userId: b.userId, planId: b.planId, settings: b.settings, currency, today: b.today, actor: "user",
    client: client ?? (await createYnabClient(env, b.db, b.userId, "interactive")),
  };
}

/** §9.5: the deterministic precision of an intent and the columns that store it. Facts are Claude's report;
 *  only what assessPrecision verifies against the user's own text reaches order_plan. */
export function precisionColumns(
  d: { merchantKind: string; totalAmount: number; approximate: boolean; lines: { amount: number; approximate: boolean }[] },
  facts: OrderFacts | null, rawText: string, decimalDigits: number,
): { p: PrecisionResult; totalTolerance: number; lineTolerance: (k: number) => number; lineExact: (k: number) => boolean;
  cols: { precision: "exact" | "approximate"; precisionNote: string | null; orderFacts: string | null; orderPlan: string | null } } {
  const p = assessPrecision({ ...d, facts }, rawText, decimalDigits);
  const totalExact = p.totalExact || (p.plan !== null && p.plan.cardTotal === d.totalAmount);
  const lineExact = (k: number) => p.linesExact[k] === true || (d.lines.length === 1 && totalExact);
  return {
    p,
    totalTolerance: toleranceFor(d.totalAmount, d.approximate, totalExact, decimalDigits),
    lineExact,
    lineTolerance: (k) => {
      const l = d.lines[k];
      return l ? toleranceFor(l.amount, l.approximate, lineExact(k), decimalDigits) : 0;
    },
    cols: {
      precision: p.level, precisionNote: precisionInfo(p).note,
      orderFacts: facts ? JSON.stringify(facts) : null, orderPlan: p.plan ? JSON.stringify(p.plan) : null,
    },
  };
}

// ── create ──────────────────────────────────────────────────────────────────

/** Rows for one confirmed draft. A single line without an amount takes the intent's total. */
function buildIntent(d: IntentCreate, b: Base, rawText: string, inputMode: InputModeT, now: number, decimalDigits: number) {
  const id = newId();
  const expiresAfter = Math.max(b.settings.staleAfterDays, dateWindow(d.merchantKind, b.settings.amazonWindowDays).after);
  const resolved = d.lines.map((l) => (l.amount !== null && l.amount > 0
    ? { amount: l.amount, approximate: l.approximate }
    : { amount: d.totalAmount, approximate: d.approximate }));
  const pc = precisionColumns({ merchantKind: d.merchantKind, totalAmount: d.totalAmount, approximate: d.approximate, lines: resolved },
    d.facts ?? null, rawText, decimalDigits);
  const row: typeof intents.$inferInsert = {
    id, userId: b.userId, planId: b.planId, shortRef: newShortRef(), status: "pending", rawText, inputMode,
    payee: d.payee, payeeId: d.payeeId, merchantKind: d.merchantKind, direction: d.direction, intentDate: d.date,
    accountId: d.accountId, accountExplicit: d.accountExplicit && d.accountId !== null,
    totalAmount: d.totalAmount, tolerance: pc.totalTolerance, approximate: d.approximate,
    ...pc.cols,
    memo: d.memo, placeholderTxnId: null, placeholderStatus: "none", placeholderAmount: null,
    expiresOn: addDays(d.date, expiresAfter), createdAt: now, updatedAt: now, resolvedAt: null,
  };
  const lines: (typeof intentLines.$inferInsert)[] = d.lines.map((l, idx) => {
    const r = resolved[idx] ?? { amount: d.totalAmount, approximate: d.approximate };
    return {
      id: newId(), intentId: id, idx, description: l.description, categoryId: l.categoryId, amount: r.amount,
      tolerance: pc.lineTolerance(idx), approximate: r.approximate, exact: pc.lineExact(idx), status: "open", matchedTxnId: null,
    };
  });
  return { row, lines, createPlaceholder: d.createPlaceholder };
}

type Built = ReturnType<typeof buildIntent>;

async function insertIntents(db: DB, userId: string, built: Built[], now: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runBatch(db, built.flatMap((b): BatchItem<"sqlite">[] => [
        db.insert(intents).values(b.row),
        ...(b.lines.length ? [db.insert(intentLines).values(b.lines)] : []),
        auditStmt(db, { userId, actor: "user", action: "intent_created", intentId: b.row.id, summary: `${b.row.payee} ${b.row.totalAmount / 1000}` }, now),
      ]));
      return;
    } catch (e) {
      // A short_ref collision (6 random chars) is the only expected unique violation: draw new refs and retry.
      if (!isUniqueViolation(e) || attempt >= 3) throw e;
      for (const b of built) b.row.shortRef = newShortRef();
    }
  }
}

/** POST /api/intents (§10.7): lock + sync + insert + reconcile the new intents + placeholders. */
export async function createIntents(env: Env, b: Base, body: { intents: IntentCreate[]; rawText: string; inputMode: InputModeT }):
Promise<{ intents: Intent[]; warnings: string[] }> {
  const now = Date.now();
  const { decimalDigits } = await getCurrency(b.db, b.userId, b.planId);
  const built = body.intents.map((d) => buildIntent(d, b, body.rawText, body.inputMode, now, decimalDigits));
  const ids = built.map((x) => x.row.id);
  const warnings: string[] = [];
  let inserted = false;
  const insertOnce = async () => {
    if (!inserted) await insertIntents(b.db, b.userId, built, now);
    inserted = true;
  };

  const placeholders = async (ctx: EngineCtx) => {
    for (const x of built) {
      const row = await requireIntent(b.db, b.userId, x.row.id);
      if (row.status === "review") {
        warnings.push(`${row.payee}: possible existing match, check Review`);
        continue;
      }
      if (row.status !== "pending" || !x.createPlaceholder || !b.settings.createPlaceholders) continue;
      const r = await createPlaceholder(ctx, row.id);
      if (r.warning) warnings.push(r.warning);
    }
  };

  const clientOrNull = async (): Promise<YnabClient | null> => {
    try {
      return await createYnabClient(env, b.db, b.userId, "interactive");
    } catch (e) {
      warnings.push(`Could not reach YNAB (${e instanceof AppError ? e.code : "error"}): placeholders were not created`);
      return null;
    }
  };

  const res = await withUserLock(env, b.db, b.userId, b.planId, async () => {
    const client = await clientOrNull();
    if (!client) {
      await insertOnce();
      return "done" as const;
    }
    let delta: Awaited<ReturnType<typeof syncPlan>> | null = null;
    try {
      delta = await syncPlan(env, b.db, client, b.userId, b.planId);
    } catch (e) {
      warnings.push(`Could not sync with YNAB (${e instanceof AppError ? e.code : "error"}); matched later`);
    }
    await insertOnce();
    const ctx = await engineCtx(env, b, client);
    if (delta) {
      const summary = await reconcileUser(ctx, delta, { onlyIntentIds: ids });
      if (summary.errors.length) warnings.push("Some matches could not be applied; they will be retried on the next sync");
    }
    await placeholders(ctx);
    return "done" as const;
  }, CREATE_LOCK_WAIT_MS);

  if (res === "locked") {
    // A cycle holds the lock: record the intents now, match them on the next sync.
    await insertOnce();
    warnings.push("Synced later");
    const client = await clientOrNull();
    if (client) await placeholders(await engineCtx(env, b, client));
  }

  const rows = await b.db.select().from(intents).where(and(eq(intents.userId, b.userId), inArray(intents.id, ids))).all();
  const order = new Map(ids.map((id, k) => [id, k]));
  rows.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  return { intents: await intentDtos(b.db, rows, b.today), warnings };
}

// ── update (PATCH) ──────────────────────────────────────────────────────────

export interface UpdateOpts {
  /** Conversational edit: the user's words are appended to raw_text, so amounts they state count as written
   *  by the user when precision is re-assessed (§9.6). */
  note?: string;
}

/** PATCH /api/intents/:id. Only a pending intent with no matched lines. */
export async function updateIntent(env: Env, b0: Base, id: string, patch: IntentPatch, opts: UpdateOpts = {}): Promise<Intent> {
  const row = await requireIntent(b0.db, b0.userId, id);
  const b = forIntent(b0, row);
  const lines = await getLinesOf(b.db, id);
  if (row.status !== "pending" || lines.some((l) => l.status === "matched")) {
    throw new AppError("conflict", "Only a pending intent with no matched lines can be edited");
  }
  const now = Date.now();
  const date = patch.date ?? row.intentDate;
  const approximate = patch.approximate ?? row.approximate;
  const newLines = patch.lines?.map((l, idx) => ({
    id: newId(), intentId: id, idx, description: l.description, categoryId: l.categoryId, amount: l.amount,
    tolerance: 0, approximate: l.approximate, exact: false, status: "open" as const, matchedTxnId: null,
  }));
  const total = patch.totalAmount ?? (newLines ? newLines.reduce((s, l) => s + l.amount, 0) : row.totalAmount);
  if (newLines && newLines.length === 1 && patch.totalAmount !== undefined && newLines[0]) newLines[0].amount = total;
  // Precision is re-assessed from the stored note (plus an edit's words) and facts: an edited amount is exact
  // only if the user wrote it.
  const rawText = opts.note !== undefined ? appendNote(row.rawText, opts.note) : row.rawText;
  const { decimalDigits } = await getCurrency(b.db, b.userId, b.planId);
  const effLines = newLines ?? lines;
  const facts = factsAfterEdit(storedFacts(row.orderFacts), opts.note, row.totalAmount, total, decimalDigits);
  const pc = precisionColumns({ merchantKind: row.merchantKind, totalAmount: total, approximate, lines: effLines },
    facts, rawText, decimalDigits);
  newLines?.forEach((l, k) => {
    l.tolerance = pc.lineTolerance(k);
    l.exact = pc.lineExact(k);
  });
  const lineUpdates = newLines ? [] : lines.map((l, k) => b.db.update(intentLines)
    .set({ tolerance: pc.lineTolerance(k), exact: pc.lineExact(k) }).where(eq(intentLines.id, l.id)));
  const accountId = patch.accountId !== undefined ? patch.accountId : row.accountId;
  const accountChanged = accountId !== row.accountId;
  const set = {
    payee: patch.payee ?? row.payee,
    intentDate: date,
    accountId,
    accountExplicit: accountId !== null && (patch.accountId !== undefined ? true : row.accountExplicit),
    totalAmount: total,
    tolerance: pc.totalTolerance,
    approximate,
    ...pc.cols,
    rawText,
    memo: patch.memo !== undefined ? patch.memo : row.memo,
    expiresOn: patch.date
      ? addDays(date, Math.max(b.settings.staleAfterDays, dateWindow(row.merchantKind, b.settings.amazonWindowDays).after))
      : row.expiresOn,
    updatedAt: now,
  };
  await runBatch(b.db, [
    b.db.update(intents).set(set).where(eq(intents.id, id)),
    ...(newLines ? [b.db.delete(intentLines).where(eq(intentLines.intentId, id)), b.db.insert(intentLines).values(newLines)] : lineUpdates),
    auditStmt(b.db, { userId: b.userId, actor: "user", action: "intent_updated", intentId: id,
      summary: opts.note !== undefined ? `${set.payee} updated by a voice/text edit` : `${set.payee} updated` }, now),
  ]);

  if (row.placeholderStatus === "created" && row.placeholderTxnId) {
    const ctx = await engineCtx(env, b);
    if (accountChanged) {
      // YNAB cannot move a txn between accounts through an update: replace the placeholder.
      const r = await safeDeletePlaceholder(ctx, id, "cancelled");
      if (r !== "refused") {
        await b.db.update(intents).set({ placeholderStatus: "none", placeholderTxnId: null, placeholderAmount: null }).where(eq(intents.id, id));
        await createPlaceholder(ctx, id);
      }
    } else {
      // §10.7 guard on a live read: YNAB may have merged the placeholder with a bank import since the last
      // sync. Then nothing is written; the txn is cached and a "check it in YNAB" review is opened.
      const p = await livePlaceholder(ctx, row, "updated");
      if (!p) return intentDto(b.db, b.userId, id, b.today);
      const ls = await getLinesOf(b.db, id);
      const largest = [...ls].sort((x, y) => y.amount - x.amount || x.idx - y.idx)[0];
      const amt = nudged(total, approximate, ctx.currency.decimalDigits);
      const tag = memoTag(row.shortRef);
      // Replace the memo only while it is still the one createPlaceholder wrote; text the user added is kept.
      const ours = mergeMemo(null, `${row.approximate ? APPROX_PREFIX : ""}${row.memo ?? lines.map((l) => l.description).join(", ")}`, tag);
      const text = set.memo ?? ls.map((l) => l.description).join(", ");
      const memo = (p.memo ?? "").trim() === ours ? mergeMemo(null, `${approximate ? APPROX_PREFIX : ""}${text}`, tag) : undefined;
      const res = await ctx.client.updateTransactions(b.planId, [{
        id: row.placeholderTxnId, amount: toYnabAmount(amt, row.direction), date: minDate(date, b.today),
        ...(largest ? { categoryId: largest.categoryId } : {}),
        ...(memo !== undefined ? { memo } : {}),
      }]);
      await runBatch(b.db, [
        ...upsertTxnsStmts(b.db, b.userId, b.planId, res, now),
        b.db.update(intents).set({ placeholderAmount: amt }).where(eq(intents.id, id)),
        auditStmt(b.db, { userId: b.userId, actor: "user", action: "placeholder_updated", intentId: id, ynabTxnId: row.placeholderTxnId, summary: `Placeholder for ${set.payee} updated` }, now),
      ]);
    }
  }
  return intentDto(b.db, b.userId, id, b.today);
}

// ── extend / cancel / keep ──────────────────────────────────────────────────

/** POST /api/intents/:id/extend: expires_on = max(today, expires_on) + days. */
export async function extendIntent(b: Base, id: string, days: number): Promise<Intent> {
  const row = await requireIntent(b.db, b.userId, id);
  if (!isOpen(row.status)) throw new AppError("conflict", "Only an open intent can be extended");
  const from = row.expiresOn > b.today ? row.expiresOn : b.today;
  const expiresOn = addDays(from, days);
  const now = Date.now();
  await runBatch(b.db, [
    b.db.update(intents).set({ expiresOn, updatedAt: now }).where(eq(intents.id, id)),
    auditStmt(b.db, { userId: b.userId, actor: "user", action: "intent_extended", intentId: id, summary: `${row.payee} extended to ${expiresOn}` }, now),
  ]);
  return intentDto(b.db, b.userId, id, b.today);
}

/** DELETE /api/intents/:id (cancel; also the stale "Delete" action). */
export async function cancelIntent(env: Env, b0: Base, id: string): Promise<Intent> {
  const row = await requireIntent(b0.db, b0.userId, id);
  const b = forIntent(b0, row);
  if (!isOpen(row.status)) throw new AppError("conflict", "This intent is already closed");
  const stale = row.expiresOn < b.today;
  let refused = false;
  if (row.placeholderStatus === "created") {
    // YNAB errors propagate: nothing is cancelled, so the placeholder is never orphaned.
    refused = (await safeDeletePlaceholder(await engineCtx(env, b), id, stale ? "stale_delete" : "cancelled")) === "refused";
  }
  const now = Date.now();
  await runBatch(b.db, [
    b.db.update(intents).set({ status: "cancelled", updatedAt: now }).where(eq(intents.id, id)),
    auditStmt(b.db, { userId: b.userId, actor: "user", action: "intent_cancelled", intentId: id, summary: `${row.payee} cancelled` }, now),
  ]);
  // Keep the "check it in YNAB" review a refused stale delete opened for the placeholder.
  await detachIntentFromReviews({ db: b.db, userId: b.userId, actor: "user" }, id, now,
    (r) => refused && r.kind === "ynab_matched_other" && r.ynabTxnId === row.placeholderTxnId);
  return intentDto(b.db, b.userId, id, b.today);
}

/** POST /api/intents/:id/keep ("Keep as final"). */
export async function keepIntent(env: Env, b0: Base, id: string): Promise<Intent> {
  const row = await requireIntent(b0.db, b0.userId, id);
  const b = forIntent(b0, row);
  if (!isOpen(row.status) || row.placeholderStatus !== "created" || !row.placeholderTxnId) {
    throw new AppError("conflict", "Only an open intent with a placeholder can be kept as final");
  }
  const ctx = await engineCtx(env, b);
  const t = await livePlaceholder(ctx, row, "kept as final");
  if (!t) throw new AppError("conflict", "The placeholder was changed or deleted in YNAB, so it was left alone. Check it in YNAB.");
  // The placeholder becomes the final entry (§10.7, like createPlaceholder's final path): the un-nudged
  // total of the open lines, split across their categories when there is more than one.
  const open = (await getLinesOf(b.db, id)).filter((l) => l.status === "open");
  const total = open.reduce((s, l) => s + l.amount, 0);
  const multi = new Set(open.map((l) => l.categoryId)).size > 1;
  const memo = stripApprox(t.memo) ?? mergeMemo(null, row.memo, memoTag(row.shortRef));
  const u: TxnUpdate = { id: row.placeholderTxnId, memo };
  if (total > 0) {
    u.amount = toYnabAmount(total, row.direction);
    if (multi) {
      u.categoryId = null;
      u.subtransactions = allocate(total, open, row.direction, ctx.currency.decimalDigits)
        .map((a) => ({ amount: a.amount, categoryId: a.categoryId, memo: a.memo }));
    } else if (open[0]) {
      u.categoryId = open[0].categoryId;
    }
  }
  const res = await ctx.client.updateTransactions(b.planId, [u]);
  const now = Date.now();
  await runBatch(b.db, [
    ...upsertTxnsStmts(b.db, b.userId, b.planId, res, now),
    b.db.update(intents).set({
      placeholderStatus: "final", placeholderAmount: total > 0 ? total : row.placeholderAmount, status: "resolved", resolvedAt: now, updatedAt: now,
    }).where(eq(intents.id, id)),
    b.db.update(intentLines).set({ status: "matched", matchedTxnId: row.placeholderTxnId })
      .where(and(eq(intentLines.intentId, id), eq(intentLines.status, "open"))),
    auditStmt(b.db, { userId: b.userId, actor: "user", action: "intent_kept_final", intentId: id, ynabTxnId: row.placeholderTxnId, summary: `${row.payee} kept as final` }, now),
  ]);
  await detachIntentFromReviews({ db: b.db, userId: b.userId, actor: "user" }, id, now);
  return intentDto(b.db, b.userId, id, b.today);
}

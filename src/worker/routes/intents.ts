// routes/intents.ts — WP5 (DESIGN §7, §10.7, §10.9): /api/intents* (except /api/intents/parse, WP4).
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { API, CreateIntentsReq, ExtendIntentReq, IntentListQuery, LinkIntentReq, UpdateIntentReq } from "../../shared/api";
import { addDays, minDate, todayIn } from "../../shared/dates";
import { toYnabAmount } from "../../shared/money";
import type { IntentCreate, Settings } from "../../shared/schemas";
import { getSettings } from "../auth/settings";
import { intentLines, intents } from "../db/schema";
import { allocate } from "../domain/allocate";
import { dateWindow } from "../domain/dates";
import { APPROX_PREFIX, memoTag, mergeMemo, stripApprox } from "../domain/memo";
import { nudged } from "../domain/nudge";
import { looseScore } from "../domain/score";
import { toleranceFor } from "../domain/tolerance";
import { assessPrecision, OrderFacts, precisionInfo, type PrecisionResult } from "../../shared/precision";
import { applyMatch, loadTxn } from "../engine/apply";
import { excludedTxnIds } from "../engine/load";
import { createPlaceholder, livePlaceholder, safeDeletePlaceholder } from "../engine/placeholders";
import { reconcileUser, type EngineCtx } from "../engine/reconcile";
import { detachIntentFromReviews } from "../engine/reviews";
import {
  getLinesOf, intentDto, intentDtos, isOpen, isUniqueViolation, requireIntent, runBatch, toDIntent, uncategorizedIds,
} from "../engine/store";
import type { AppEnv, BatchItem, DB } from "../env";
import { withUserLock } from "../jobs/cycle";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { newId, newShortRef } from "../lib/ids";
import { validate } from "../lib/validate";
import { getAccounts, getCachedTxns, getCurrency, toTxnView, upsertTxnsStmts } from "../ynab/cache";
import { createYnabClient, type YnabClient } from "../ynab/client";
import type { TxnUpdate } from "../ynab/types";
import { syncPlan } from "../ynab/sync";

export const intentRoutes = new Hono<AppEnv>();

/** How long intent creation waits for a cycle holding the user lock (§10.7). */
export const CREATE_LOCK_WAIT_MS = 5_000;
const CANDIDATE_DAYS = 45;
const MAX_CANDIDATES = 30;
const RESOLVED_LIST_DAYS = 30;
const LIST_LIMIT = 200;

interface Base { db: DB; userId: string; settings: Settings; planId: string; today: string }

/** §9.5: the deterministic precision of an intent and the columns that store it. Facts are Claude's report;
 *  only what assessPrecision verifies against the user's own text reaches order_plan. */
function precisionColumns(
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

/** Stored facts JSON → OrderFacts, or null. */
function storedFacts(json: string | null): OrderFacts | null {
  if (json === null) return null;
  try {
    const r = OrderFacts.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

async function base(c: Context<AppEnv>): Promise<Base> {
  const { db, userId } = c.var;
  const settings = await getSettings(db, userId);
  if (!settings.planId) throw new AppError("no_plan_selected", "Choose a YNAB plan first");
  return { db, userId, settings, planId: settings.planId, today: todayIn(settings.timezone) };
}

/** Per-intent routes act on the intent's own plan, not the currently selected one (the user may have switched). */
const forIntent = (b: Base, row: { planId: string }): Base => (row.planId === b.planId ? b : { ...b, planId: row.planId });

async function engineCtx(c: Context<AppEnv>, b: Base, client?: YnabClient): Promise<EngineCtx> {
  const { planName: _n, ...currency } = await getCurrency(b.db, b.userId, b.planId);
  return {
    env: c.env, db: b.db, userId: b.userId, planId: b.planId, settings: b.settings, currency, today: b.today, actor: "user",
    client: client ?? (await createYnabClient(c.env, b.db, b.userId, "interactive")),
  };
}

const respond = <T>(schema: { parse: (x: unknown) => T }, value: unknown) => schema.parse(value);

// ── POST /api/intents ─────────────────────────────────────────────────────────

/** Rows for one confirmed draft. A single line without an amount takes the intent's total. */
function buildIntent(d: IntentCreate, b: Base, rawText: string, inputMode: "typed" | "browser_stt" | "server_stt", now: number, decimalDigits: number) {
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

intentRoutes.post("/intents", validate("json", CreateIntentsReq), async (c) => {
  const body = c.req.valid("json");
  const b = await base(c);
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
      return await createYnabClient(c.env, b.db, b.userId, "interactive");
    } catch (e) {
      warnings.push(`Could not reach YNAB (${e instanceof AppError ? e.code : "error"}): placeholders were not created`);
      return null;
    }
  };

  const res = await withUserLock(c.env, b.db, b.userId, b.planId, async () => {
    const client = await clientOrNull();
    if (!client) {
      await insertOnce();
      return "done" as const;
    }
    let delta: Awaited<ReturnType<typeof syncPlan>> | null = null;
    try {
      delta = await syncPlan(c.env, b.db, client, b.userId, b.planId);
    } catch (e) {
      warnings.push(`Could not sync with YNAB (${e instanceof AppError ? e.code : "error"}); matched later`);
    }
    await insertOnce();
    const ctx = await engineCtx(c, b, client);
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
    if (client) await placeholders(await engineCtx(c, b, client));
  }

  const rows = await b.db.select().from(intents).where(and(eq(intents.userId, b.userId), inArray(intents.id, ids))).all();
  const order = new Map(ids.map((id, k) => [id, k]));
  rows.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  return c.json(respond(API.createIntents.res, { intents: await intentDtos(b.db, rows, b.today), warnings }));
});

// ── GET /api/intents, /api/intents/:id ───────────────────────────────────────

intentRoutes.get("/intents", validate("query", IntentListQuery), async (c) => {
  const { status } = c.req.valid("query");
  const b = await base(c);
  const own = and(eq(intents.userId, b.userId), eq(intents.planId, b.planId));
  const where = status === "open"
    ? and(own, inArray(intents.status, ["pending", "partial", "review"]))
    : status === "stale"
      ? and(own, inArray(intents.status, ["pending", "partial", "review"]), lt(intents.expiresOn, b.today))
      : status === "resolved"
        ? and(own, eq(intents.status, "resolved"), gte(intents.resolvedAt, Date.now() - RESOLVED_LIST_DAYS * 86_400_000))
        : and(own, eq(intents.status, "cancelled"));
  const order = status === "resolved" ? desc(intents.resolvedAt) : status === "cancelled" ? desc(intents.updatedAt) : desc(intents.createdAt);
  const rows = await b.db.select().from(intents).where(where).orderBy(order).limit(LIST_LIMIT).all();
  return c.json(respond(API.listIntents.res, { intents: await intentDtos(b.db, rows, b.today) }));
});

intentRoutes.get("/intents/:id", async (c) => {
  const b = await base(c);
  return c.json(respond(API.getIntent.res, { intent: await intentDto(b.db, b.userId, c.req.param("id"), b.today) }));
});

// ── PATCH /api/intents/:id ────────────────────────────────────────────────────

intentRoutes.patch("/intents/:id", validate("json", UpdateIntentReq), async (c) => {
  const patch = c.req.valid("json");
  const id = c.req.param("id");
  const b0 = await base(c);
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
  // Precision is re-assessed from the stored note and facts: an edited amount is exact only if it is in the note.
  const { decimalDigits } = await getCurrency(b.db, b.userId, b.planId);
  const effLines = newLines ?? lines;
  const pc = precisionColumns({ merchantKind: row.merchantKind, totalAmount: total, approximate, lines: effLines },
    storedFacts(row.orderFacts), row.rawText, decimalDigits);
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
    memo: patch.memo !== undefined ? patch.memo : row.memo,
    expiresOn: patch.date
      ? addDays(date, Math.max(b.settings.staleAfterDays, dateWindow(row.merchantKind, b.settings.amazonWindowDays).after))
      : row.expiresOn,
    updatedAt: now,
  };
  await runBatch(b.db, [
    b.db.update(intents).set(set).where(eq(intents.id, id)),
    ...(newLines ? [b.db.delete(intentLines).where(eq(intentLines.intentId, id)), b.db.insert(intentLines).values(newLines)] : lineUpdates),
    auditStmt(b.db, { userId: b.userId, actor: "user", action: "intent_updated", intentId: id, summary: `${set.payee} updated` }, now),
  ]);

  if (row.placeholderStatus === "created" && row.placeholderTxnId) {
    const ctx = await engineCtx(c, b);
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
      if (!p) return c.json(respond(API.updateIntent.res, { intent: await intentDto(b.db, b.userId, id, b.today) }));
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
  return c.json(respond(API.updateIntent.res, { intent: await intentDto(b.db, b.userId, id, b.today) }));
});

// ── POST /api/intents/:id/extend ───────────────────────────────────────────────

intentRoutes.post("/intents/:id/extend", validate("json", ExtendIntentReq), async (c) => {
  const { days } = c.req.valid("json");
  const b = await base(c);
  const id = c.req.param("id");
  const row = await requireIntent(b.db, b.userId, id);
  if (!isOpen(row.status)) throw new AppError("conflict", "Only an open intent can be extended");
  const from = row.expiresOn > b.today ? row.expiresOn : b.today;
  const expiresOn = addDays(from, days);
  const now = Date.now();
  await runBatch(b.db, [
    b.db.update(intents).set({ expiresOn, updatedAt: now }).where(eq(intents.id, id)),
    auditStmt(b.db, { userId: b.userId, actor: "user", action: "intent_extended", intentId: id, summary: `${row.payee} extended to ${expiresOn}` }, now),
  ]);
  return c.json(respond(API.extendIntent.res, { intent: await intentDto(b.db, b.userId, id, b.today) }));
});

// ── DELETE /api/intents/:id (cancel; also the stale "Delete" action) ────────────

intentRoutes.delete("/intents/:id", async (c) => {
  const id = c.req.param("id");
  const b0 = await base(c);
  const row = await requireIntent(b0.db, b0.userId, id);
  const b = forIntent(b0, row);
  if (!isOpen(row.status)) throw new AppError("conflict", "This intent is already closed");
  const stale = row.expiresOn < b.today;
  let refused = false;
  if (row.placeholderStatus === "created") {
    // YNAB errors propagate: nothing is cancelled, so the placeholder is never orphaned.
    refused = (await safeDeletePlaceholder(await engineCtx(c, b), id, stale ? "stale_delete" : "cancelled")) === "refused";
  }
  const now = Date.now();
  await runBatch(b.db, [
    b.db.update(intents).set({ status: "cancelled", updatedAt: now }).where(eq(intents.id, id)),
    auditStmt(b.db, { userId: b.userId, actor: "user", action: "intent_cancelled", intentId: id, summary: `${row.payee} cancelled` }, now),
  ]);
  // Keep the "check it in YNAB" review a refused stale delete opened for the placeholder.
  await detachIntentFromReviews({ db: b.db, userId: b.userId, actor: "user" }, id, now,
    (r) => refused && r.kind === "ynab_matched_other" && r.ynabTxnId === row.placeholderTxnId);
  return c.json(respond(API.cancelIntent.res, { intent: await intentDto(b.db, b.userId, id, b.today) }));
});

// ── POST /api/intents/:id/keep ("Keep as final") ────────────────────────────────

intentRoutes.post("/intents/:id/keep", async (c) => {
  const id = c.req.param("id");
  const b0 = await base(c);
  const row = await requireIntent(b0.db, b0.userId, id);
  const b = forIntent(b0, row);
  if (!isOpen(row.status) || row.placeholderStatus !== "created" || !row.placeholderTxnId) {
    throw new AppError("conflict", "Only an open intent with a placeholder can be kept as final");
  }
  const ctx = await engineCtx(c, b);
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
  return c.json(respond(API.keepIntent.res, { intent: await intentDto(b.db, b.userId, id, b.today) }));
});

// ── GET /api/intents/:id/candidates ────────────────────────────────────────────

intentRoutes.get("/intents/:id/candidates", async (c) => {
  const id = c.req.param("id");
  const b0 = await base(c);
  const row = await requireIntent(b0.db, b0.userId, id);
  const b = forIntent(b0, row);
  const di = toDIntent(row, await getLinesOf(b.db, id));
  const excluded = await excludedTxnIds(b.db, b.userId, b.planId);
  const txns = await getCachedTxns(b.db, b.userId, b.planId, { sinceDate: addDays(b.today, -CANDIDATE_DAYS) });
  const scored = txns
    .map((t) => ({ t, s: looseScore(di, t, excluded, b.settings.amazonWindowDays) }))
    .filter((x): x is { t: typeof x.t; s: number } => x.s !== null)
    .sort((x, y) => y.s - x.s || y.t.date.localeCompare(x.t.date))
    .slice(0, MAX_CANDIDATES);
  const accounts = new Map((await getAccounts(b.db, b.userId, b.planId)).map((a) => [a.id, a]));
  const uncat = await uncategorizedIds(b.db, b.userId, b.planId);
  return c.json(respond(API.candidates.res, { transactions: scored.map((x) => toTxnView(x.t, accounts, uncat)) }));
});

// ── POST /api/intents/:id/link ─────────────────────────────────────────────────

intentRoutes.post("/intents/:id/link", validate("json", LinkIntentReq), async (c) => {
  const { transactionId, lineIds } = c.req.valid("json");
  const id = c.req.param("id");
  const b0 = await base(c);
  const row = await requireIntent(b0.db, b0.userId, id);
  const b = forIntent(b0, row);
  if (!isOpen(row.status)) throw new AppError("conflict", "This intent is already closed");
  // Checked first (§7): placeholders of any intent, live matches and open-review txns.
  if ((await excludedTxnIds(b.db, b.userId, b.planId)).has(transactionId)) {
    throw new AppError("conflict", "This transaction is already linked or waiting for a review");
  }
  const lines = await getLinesOf(b.db, id);
  const open = lines.filter((l) => l.status === "open");
  const chosen = lineIds === null ? open : open.filter((l) => lineIds.includes(l.id));
  if (chosen.length === 0 || (lineIds !== null && chosen.length !== new Set(lineIds).size)) {
    throw new AppError("validation", "Choose open lines of this intent");
  }
  const ctx = await engineCtx(c, b);
  const t = await loadTxn(ctx, transactionId);
  if (!t || t.deleted) throw new AppError("not_found", "Transaction not found");
  if ((row.direction === "outflow" ? t.amount >= 0 : t.amount <= 0)) {
    throw new AppError("validation", row.direction === "outflow" ? "That transaction is not an outflow" : "That transaction is not an inflow");
  }
  const allocation = allocate(Math.abs(t.amount), chosen, row.direction, ctx.currency.decimalDigits);
  await applyMatch(ctx, { intentId: id, txnId: t.id, lineIds: chosen.map((l) => l.id), allocation, score: null, kind: "manual" });
  const after = await requireIntent(b.db, b.userId, id);
  if (after.status === "resolved" || after.status === "partial") {
    await detachIntentFromReviews({ db: b.db, userId: b.userId, actor: "user" }, id);
  }
  return c.json(respond(API.linkIntent.res, { intent: await intentDto(b.db, b.userId, id, b.today) }));
});

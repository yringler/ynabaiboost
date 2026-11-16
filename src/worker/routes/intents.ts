// routes/intents.ts — WP5 (DESIGN §7, §10.7, §10.9): /api/intents* (except /api/intents/parse, WP4, and
// /api/intents/edit*, §9.6). The write paths live in services/intents.ts so the conversational-edit executor
// runs exactly the same code.
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { API, CreateIntentsReq, ExtendIntentReq, IntentListQuery, LinkIntentReq, UpdateIntentReq } from "../../shared/api";
import { addDays } from "../../shared/dates";
import { intents } from "../db/schema";
import { allocate } from "../domain/allocate";
import { looseScore } from "../domain/score";
import { applyMatch, loadTxn } from "../engine/apply";
import { excludedTxnIds } from "../engine/load";
import { detachIntentFromReviews } from "../engine/reviews";
import { getLinesOf, intentDto, intentDtos, isOpen, requireIntent, toDIntent, uncategorizedIds } from "../engine/store";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validate";
import {
  cancelIntent, createIntents, engineCtx, extendIntent, forIntent, keepIntent, loadBase, updateIntent, type Base,
} from "../services/intents";
import { getAccounts, getCachedTxns, toTxnView } from "../ynab/cache";

export { CREATE_LOCK_WAIT_MS } from "../services/intents";

export const intentRoutes = new Hono<AppEnv>();

const CANDIDATE_DAYS = 45;
const MAX_CANDIDATES = 30;
const RESOLVED_LIST_DAYS = 30;
const LIST_LIMIT = 200;

const base = (c: Context<AppEnv>): Promise<Base> => loadBase(c.var.db, c.var.userId);

const respond = <T>(schema: { parse: (x: unknown) => T }, value: unknown) => schema.parse(value);

// ── POST /api/intents ─────────────────────────────────────────────────────────

intentRoutes.post("/intents", validate("json", CreateIntentsReq), async (c) => {
  const body = c.req.valid("json");
  const b = await base(c);
  return c.json(respond(API.createIntents.res, await createIntents(c.env, b, body)));
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
  const intent = await updateIntent(c.env, await base(c), c.req.param("id"), patch);
  return c.json(respond(API.updateIntent.res, { intent }));
});

// ── POST /api/intents/:id/extend ───────────────────────────────────────────────

intentRoutes.post("/intents/:id/extend", validate("json", ExtendIntentReq), async (c) => {
  const { days } = c.req.valid("json");
  const intent = await extendIntent(await base(c), c.req.param("id"), days);
  return c.json(respond(API.extendIntent.res, { intent }));
});

// ── DELETE /api/intents/:id (cancel; also the stale "Delete" action) ────────────

intentRoutes.delete("/intents/:id", async (c) => {
  const intent = await cancelIntent(c.env, await base(c), c.req.param("id"));
  return c.json(respond(API.cancelIntent.res, { intent }));
});

// ── POST /api/intents/:id/keep ("Keep as final") ────────────────────────────────

intentRoutes.post("/intents/:id/keep", async (c) => {
  const intent = await keepIntent(c.env, await base(c), c.req.param("id"));
  return c.json(respond(API.keepIntent.res, { intent }));
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
  const ctx = await engineCtx(c.env, b);
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

// routes/reviews.ts — WP5 (DESIGN §7, §10.6, §10.9): GET /api/reviews, POST /api/reviews/:id/resolve.
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { API, ResolveReviewReq } from "../../shared/api";
import { todayIn } from "../../shared/dates";
import { getSettings } from "../auth/settings";
import { intents, reviews } from "../db/schema";
import { applyMatch } from "../engine/apply";
import { closeReview, parseOptions, reviewIntentIds } from "../engine/reviews";
import { chunk, getLinesOf, intentDtos, isOpen, openReviews, uncategorizedIds } from "../engine/store";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validate";
import { getAccounts, getCachedTxns, getCurrency, toTxnView } from "../ynab/cache";
import { createYnabClient } from "../ynab/client";

export const reviewRoutes = new Hono<AppEnv>();

reviewRoutes.get("/reviews", async (c) => {
  const { db, userId } = c.var;
  const settings = await getSettings(db, userId);
  const today = todayIn(settings.timezone);
  const rows = await openReviews(db, userId);
  if (rows.length === 0) return c.json(API.listReviews.res.parse({ reviews: [] }));

  const intentIds = [...new Set(rows.flatMap((r) => reviewIntentIds(r)))];
  const intentRows = (await Promise.all(chunk(intentIds).map((ids) =>
    db.select().from(intents).where(and(eq(intents.userId, userId), inArray(intents.id, ids))).all()))).flat();
  const dtos = new Map((await intentDtos(db, intentRows, today)).map((i) => [i.id, i]));

  // Transactions live in the cache of the plan their intents belong to (normally the current plan).
  const plans = new Set(intentRows.map((r) => r.planId));
  if (settings.planId) plans.add(settings.planId);
  const txnIds = [...new Set(rows.flatMap((r) => [...(r.ynabTxnId ? [r.ynabTxnId] : []), ...parseOptions(r.options).map((o) => o.transactionId)]))];
  const views = new Map<string, ReturnType<typeof toTxnView>>();
  for (const planId of plans) {
    const txns = await getCachedTxns(db, userId, planId, { ids: txnIds, includeDeleted: true });
    if (txns.length === 0) continue;
    const accounts = new Map((await getAccounts(db, userId, planId)).map((a) => [a.id, a]));
    const uncat = await uncategorizedIds(db, userId, planId);
    for (const t of txns) views.set(t.id, toTxnView(t, accounts, uncat));
  }

  const out = rows.map((r) => {
    const options = parseOptions(r.options);
    const ids = reviewIntentIds(r);
    const tx = [...new Set([...(r.ynabTxnId ? [r.ynabTxnId] : []), ...options.map((o) => o.transactionId)])];
    return {
      id: r.id, kind: r.kind, intentId: r.intentId, transactionId: r.ynabTxnId, summary: r.summary, createdAt: r.createdAt, options,
      transactions: tx.flatMap((id) => { const v = views.get(id); return v ? [v] : []; }),
      intents: ids.flatMap((id) => { const v = dtos.get(id); return v ? [v] : []; }),
    };
  });
  return c.json(API.listReviews.res.parse({ reviews: out }));
});

reviewRoutes.post("/reviews/:id/resolve", validate("json", ResolveReviewReq), async (c) => {
  const body = c.req.valid("json");
  const { db, userId } = c.var;
  const review = await db.select().from(reviews).where(and(eq(reviews.id, c.req.param("id")), eq(reviews.userId, userId))).get();
  if (!review) throw new AppError("not_found", "Review not found");
  if (review.status !== "open") throw new AppError("conflict", "This review is already closed");
  const actorCtx = { db, userId, actor: "user" as const };

  if ("dismiss" in body) {
    // ynab_matched_other: dismiss leaves the YNAB txn untouched; the intent stays pending without a placeholder.
    if (review.kind === "ynab_matched_other" && review.intentId) {
      await db.update(intents).set({ placeholderStatus: "missing", updatedAt: Date.now() })
        .where(and(eq(intents.id, review.intentId), eq(intents.userId, userId), eq(intents.placeholderStatus, "created")));
    }
    await closeReview(actorCtx, review, "dismissed", null);
    return c.json(API.resolveReview.res.parse({ ok: true }));
  }

  const option = parseOptions(review.options).find((o) => o.id === body.optionId);
  if (!option) throw new AppError("validation", "Unknown option");
  const intent = await db.select().from(intents).where(and(eq(intents.id, option.intentId), eq(intents.userId, userId))).get();
  if (!intent) throw new AppError("not_found", "Intent not found");
  if (!isOpen(intent.status)) throw new AppError("conflict", "This intent is already closed");
  const open = new Set((await getLinesOf(db, intent.id)).filter((l) => l.status === "open").map((l) => l.id));
  if (option.lineIds.some((id) => !open.has(id))) throw new AppError("conflict", "Some of these items are already matched");

  const settings = await getSettings(db, userId);
  const { planName: _n, ...currency } = await getCurrency(db, userId, intent.planId);
  const ctx = {
    env: c.env, db, userId, planId: intent.planId, settings, currency, today: todayIn(settings.timezone), actor: "user" as const,
    client: await createYnabClient(c.env, db, userId, "interactive"),
  };
  await applyMatch(ctx, {
    intentId: option.intentId, txnId: option.transactionId, lineIds: option.lineIds, allocation: option.allocation,
    score: option.score, kind: "review",
  });
  // A split_conflict found while applying replaces this (intent-keyed) review in place: leave that one open.
  const current = await db.select({ status: reviews.status, kind: reviews.kind }).from(reviews).where(eq(reviews.id, review.id)).get();
  if (current?.status === "open" && current.kind === review.kind) await closeReview(actorCtx, review, "resolved", option.intentId);
  return c.json(API.resolveReview.res.parse({ ok: true }));
});

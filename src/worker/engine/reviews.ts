// engine/reviews.ts — WP5 internal: persisting reviews and keeping intents.status in step (DESIGN §5, §10.6, §10.9).
// Invariant: every intent that appears in an open review (owner or option) has status 'review'.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ReviewOption, type ReviewKind } from "../../shared/schemas";
import { intents, reviews } from "../db/schema";
import type { Actor, BatchItem, DB } from "../env";
import { auditStmt } from "../lib/audit";
import { newId } from "../lib/ids";
import { isUniqueViolation, openReviews, runBatch, statusAfterReview, type ReviewRow } from "./store";

export interface NewReview {
  intentId: string | null; txnId: string | null; kind: ReviewKind; summary: string; options: ReviewOption[];
}
interface Ctx { db: DB; userId: string; actor: Actor }

export function parseOptions(json: string): ReviewOption[] {
  try {
    const r = ReviewOption.array().safeParse(JSON.parse(json));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

/** Intent ids a review touches: the owner and every option's intent. */
export function reviewIntentIds(r: Pick<ReviewRow, "intentId" | "options">): string[] {
  const ids = new Set<string>();
  if (r.intentId) ids.add(r.intentId);
  for (const o of parseOptions(r.options)) ids.add(o.intentId);
  return [...ids];
}

/** Stable identity of a review's content, to avoid re-opening one the user already dismissed. */
function signature(kind: ReviewKind, options: ReviewOption[]): string {
  return `${kind}|${options.map((o) => `${o.intentId}:${o.transactionId}:${[...o.lineIds].sort().join(",")}`).sort().join(";")}`;
}

/** Creates (or replaces the options of) the open review for an intent, or for a txn when intentId is null.
 *  Returns null when the user already dismissed an identical review. Moves every referenced intent that is
 *  still open to status 'review'. */
export async function upsertOpenReview(ctx: Ctx, r: NewReview, now = Date.now()): Promise<{ id: string; created: boolean } | null> {
  const { db, userId } = ctx;
  if (r.intentId === null && r.txnId === null) throw new Error("upsertOpenReview: a review needs an intent or a transaction");
  const key = r.intentId !== null
    ? and(eq(reviews.userId, userId), eq(reviews.intentId, r.intentId))
    : and(eq(reviews.userId, userId), isNull(reviews.intentId), eq(reviews.ynabTxnId, r.txnId as string));

  const sig = signature(r.kind, r.options);
  const dismissed = await db.select({ kind: reviews.kind, options: reviews.options }).from(reviews)
    .where(and(key, eq(reviews.status, "dismissed"))).all();
  if (dismissed.some((d) => signature(d.kind, parseOptions(d.options)) === sig)) return null;

  const touched = new Set<string>(r.options.map((o) => o.intentId));
  if (r.intentId) touched.add(r.intentId);
  const statusStmt = touched.size
    ? [db.update(intents).set({ status: "review", updatedAt: now })
      .where(and(eq(intents.userId, userId), inArray(intents.id, [...touched]), inArray(intents.status, ["pending", "partial", "review"])))]
    : [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await db.select().from(reviews).where(and(key, eq(reviews.status, "open"))).get();
    if (existing) {
      // Intents that dropped out of the replaced options go back to pending/partial.
      const before = reviewIntentIds(existing).filter((id) => !touched.has(id));
      await runBatch(db, [
        db.update(reviews).set({ kind: r.kind, options: JSON.stringify(r.options), summary: r.summary, ynabTxnId: r.txnId })
          .where(eq(reviews.id, existing.id)),
        ...statusStmt,
      ]);
      await releaseIntents(db, userId, before, now);
      return { id: existing.id, created: false };
    }
    const id = newId();
    try {
      await runBatch(db, [
        db.insert(reviews).values({
          id, userId, intentId: r.intentId, ynabTxnId: r.txnId, kind: r.kind, options: JSON.stringify(r.options),
          summary: r.summary, status: "open", createdAt: now, resolvedAt: null,
        }),
        ...statusStmt,
        auditStmt(db, { userId, actor: ctx.actor, action: "review_created", summary: r.summary.slice(0, 300), intentId: r.intentId, ynabTxnId: r.txnId }, now),
      ]);
      return { id, created: true };
    } catch (e) {
      if (!isUniqueViolation(e) || attempt > 0) throw e; // a concurrent insert won: update it instead
    }
  }
  return null;
}

/** Intents in status 'review' that no other open review references go back to pending/partial. */
export async function releaseIntents(db: DB, userId: string, intentIds: string[], now = Date.now(), exceptReviewId?: string): Promise<void> {
  if (intentIds.length === 0) return;
  const stillReferenced = new Set<string>();
  for (const r of await openReviews(db, userId)) {
    if (r.id === exceptReviewId) continue;
    for (const id of reviewIntentIds(r)) stillReferenced.add(id);
  }
  const stmts: BatchItem<"sqlite">[] = [];
  for (const id of intentIds) {
    if (stillReferenced.has(id)) continue;
    const status = await statusAfterReview(db, id);
    stmts.push(db.update(intents).set({ status, updatedAt: now })
      .where(and(eq(intents.userId, userId), eq(intents.id, id), eq(intents.status, "review"))));
  }
  await runBatch(db, stmts);
}

/** Closes an open review (resolved or dismissed) and releases every referenced intent except `keepIntentId`. */
export async function closeReview(ctx: Ctx, review: ReviewRow, status: "resolved" | "dismissed", keepIntentId: string | null, now = Date.now()): Promise<void> {
  const { db, userId } = ctx;
  await runBatch(db, [
    db.update(reviews).set({ status, resolvedAt: now }).where(and(eq(reviews.id, review.id), eq(reviews.status, "open"))),
    auditStmt(db, {
      userId, actor: ctx.actor, action: status === "resolved" ? "review_resolved" : "review_dismissed",
      summary: review.summary.slice(0, 300), intentId: keepIntentId ?? review.intentId, ynabTxnId: review.ynabTxnId,
    }, now),
  ]);
  await releaseIntents(db, userId, reviewIntentIds(review).filter((id) => id !== keepIntentId), now, review.id);
}

/** An intent leaves every open review (it was matched, cancelled or kept as final): reviews it owns are
 *  dismissed, its options are removed from cross-intent reviews (a review left without options is dismissed),
 *  and the other intents those reviews referenced are released. */
export async function detachIntentFromReviews(ctx: Ctx, intentId: string, now = Date.now(), keep?: (r: ReviewRow) => boolean): Promise<void> {
  const { db, userId } = ctx;
  for (const r of await openReviews(db, userId)) {
    if (keep?.(r)) continue;
    const ids = reviewIntentIds(r);
    if (!ids.includes(intentId)) continue;
    const remaining = parseOptions(r.options).filter((o) => o.intentId !== intentId);
    if (r.intentId === intentId || remaining.length === 0) {
      await db.update(reviews).set({ status: "dismissed", resolvedAt: now }).where(eq(reviews.id, r.id));
      await releaseIntents(db, userId, ids.filter((id) => id !== intentId), now, r.id);
    } else {
      await db.update(reviews).set({ options: JSON.stringify(remaining) }).where(eq(reviews.id, r.id));
      const left = new Set(remaining.map((o) => o.intentId));
      await releaseIntents(db, userId, ids.filter((id) => id !== intentId && !left.has(id)), now);
    }
  }
}

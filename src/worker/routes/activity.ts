// routes/activity.ts — WP5 (DESIGN §7, §10.10): GET /api/activity?before=<at>. Read-only feed, pages of 50.
import { and, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { API, ActivityQuery } from "../../shared/api";
import type { ActivityEntry } from "../../shared/schemas";
import { auditLog } from "../db/schema";
import type { AppEnv } from "../env";
import { validate } from "../lib/validate";

export const activityRoutes = new Hono<AppEnv>();
export const ACTIVITY_PAGE = 50;

type Row = typeof auditLog.$inferSelect;
const toEntry = (r: Row): ActivityEntry => ({
  id: r.id, at: r.at, actor: r.actor, action: r.action, summary: r.summary, intentId: r.intentId, transactionId: r.ynabTxnId,
});

activityRoutes.get("/activity", validate("query", ActivityQuery), async (c) => {
  const { before } = c.req.valid("query");
  const { db, userId } = c.var;
  const mine = eq(auditLog.userId, userId);
  const rows = await db.select().from(auditLog)
    .where(before !== undefined ? and(mine, lt(auditLog.at, before)) : mine)
    .orderBy(desc(auditLog.at), desc(auditLog.id)).limit(ACTIVITY_PAGE).all();
  let page = rows;
  let nextCursor: number | null = null;
  const last = rows[rows.length - 1];
  if (rows.length === ACTIVITY_PAGE && last) {
    // The cursor is a timestamp: finish the last millisecond on this page so no entry is skipped.
    const sameMs = await db.select().from(auditLog).where(and(mine, eq(auditLog.at, last.at))).orderBy(desc(auditLog.id)).all();
    const seen = new Set(rows.map((r) => r.id));
    page = [...rows, ...sameMs.filter((r) => !seen.has(r.id))];
    const more = await db.select({ id: auditLog.id }).from(auditLog).where(and(mine, lt(auditLog.at, last.at))).limit(1).get();
    nextCursor = more ? last.at : null;
  }
  return c.json(API.activity.res.parse({ entries: page.map(toEntry), nextCursor }));
});

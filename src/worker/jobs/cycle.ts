// jobs/cycle.ts — WP3 (DESIGN §8.3, §10.11).
// Owner decisions: cron every 6 h; "Sync now" (POST /api/sync, trigger "manual") is the only user-initiated
// sync; intent creation syncs under the same lock (WP5). Nothing syncs on app open/focus.
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { todayIn } from "../../shared/dates";
import type { ErrorCode } from "../../shared/api";
import type { SyncResult } from "../../shared/schemas";
import { getSettings } from "../auth/settings";
import { getUser, isAllowed } from "../auth/users";
import { getDb } from "../db/client";
import { syncState, users } from "../db/schema";
import { reconcileUser } from "../engine/reconcile";
import type { DB } from "../env";
import { AppError } from "../lib/errors";
import { getCurrency } from "../ynab/cache";
import { createYnabClient } from "../ynab/client";
import { syncPlan } from "../ynab/sync";

export type CycleTrigger = "cron" | "manual" | "intent_create";

export const LOCK_TTL_MS = 120_000;
export const LOCK_POLL_MS = 250;
export const MANUAL_THROTTLE_MS = 60_000;
export const CRON_THROTTLE_MS = 30 * 60_000;
export const CRON_MAX_USERS = 50;

type Skipped = SyncResult["skipped"];
type CycleError = SyncResult["errors"][number];

const emptyResult = (ranAt: number, skipped: Skipped = null, errors: CycleError[] = []): SyncResult => ({
  ranAt, skipped, changedTransactions: 0, matched: 0, reviewsCreated: 0, stale: 0, errors,
});

function toCycleError(e: unknown): CycleError {
  if (e instanceof AppError) return { code: e.code, message: e.message };
  return { code: "internal" satisfies ErrorCode, message: "Unexpected error during sync" };
}

/** Acquire sync_state.lock_until (120 s) for (user, plan), run fn, release. If held, poll every 250 ms up to
 *  `waitMs` (default 0) and return "locked" if still held. Used by runUserCycle and POST /api/intents. */
export async function withUserLock<T>(env: Env, db: DB, userId: string, planId: string, fn: () => Promise<T>, waitMs = 0): Promise<T | "locked"> {
  void env;
  const where = and(eq(syncState.userId, userId), eq(syncState.planId, planId));
  await db.insert(syncState).values({ userId, planId }).onConflictDoNothing();
  const deadline = Date.now() + waitMs;
  let token: number | null = null;
  for (;;) {
    const now = Date.now();
    const candidate = now + LOCK_TTL_MS;
    // Conditional UPDATE … RETURNING: atomic in SQLite, so only one caller can win an expired/free lock.
    const won = await db.update(syncState).set({ lockUntil: candidate })
      .where(and(where, or(isNull(syncState.lockUntil), lt(syncState.lockUntil, now))))
      .returning({ lockUntil: syncState.lockUntil });
    if (won.length > 0) {
      token = candidate;
      break;
    }
    if (Date.now() + LOCK_POLL_MS > deadline) return "locked";
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock (a lock that expired and was re-taken has a different value).
    await db.update(syncState).set({ lockUntil: null }).where(and(where, eq(syncState.lockUntil, token)));
  }
}

export async function runUserCycle(env: Env, userId: string, trigger: CycleTrigger): Promise<SyncResult> {
  const db = getDb(env);
  const now = Date.now();
  if (!isAllowed(env, userId)) return emptyResult(now, "not_allowed");
  const user = await getUser(db, userId);
  if (!user) return emptyResult(now, "not_allowed");
  if (user.needsReauth) return emptyResult(now, "reauth");
  const settings = await getSettings(db, userId);
  const planId = settings.planId;
  if (!planId) return emptyResult(now, "no_plan");

  const stateWhere = and(eq(syncState.userId, userId), eq(syncState.planId, planId));
  const state = await db.select().from(syncState).where(stateWhere).get();
  const lastCycleAt = state?.lastCycleAt ?? null;
  if (trigger === "manual" && lastCycleAt !== null && now - lastCycleAt < MANUAL_THROTTLE_MS) return emptyResult(now, "throttled");
  if (trigger === "cron") {
    if (lastCycleAt !== null && now - lastCycleAt < CRON_THROTTLE_MS) return emptyResult(now, "throttled");
    // The initial sync (5 requests) only runs on an interactive request (§10.11). "no_plan": the plan is not ready yet.
    if (!state || state.serverKnowledge === null) return emptyResult(now, "no_plan");
  }
  if (state?.rateLimitedUntil != null && state.rateLimitedUntil > now) return emptyResult(now, "rate_limited");

  const result = emptyResult(now);
  let r: "done" | "locked";
  try {
    r = await withUserLock(env, db, userId, planId, async () => {
      const client = await createYnabClient(env, db, userId, trigger === "cron" ? "background" : "interactive");
      const delta = await syncPlan(env, db, client, userId, planId);
      result.changedTransactions = delta.changedTxnIds.length + delta.deletedTxnIds.length;
      const { planName: _planName, ...currency } = await getCurrency(db, userId, planId);
      const summary = await reconcileUser({
        env, db, client, userId, planId, settings, currency,
        today: todayIn(settings.timezone, new Date(now)), actor: trigger === "cron" ? "cron" : "user",
      }, delta);
      result.matched = summary.matched;
      result.reviewsCreated = summary.reviewsCreated;
      result.stale = summary.stale;
      for (const message of summary.errors) result.errors.push({ code: "engine", message });
      return "done" as const;
    });
  } catch (e) {
    result.skipped = "error";
    result.errors.unshift(toCycleError(e));
    r = "done";
  }
  if (r === "locked") return emptyResult(now, "locked");

  const first = result.errors[0];
  await db.update(syncState).set({
    lastCycleAt: now,
    lastError: first ? `${first.code}: ${first.message}`.slice(0, 500) : null,
  }).where(stateWhere);
  return result;
}

export async function runCron(env: Env): Promise<void> {
  const db = getDb(env);
  // Users whose last cycle (any plan) is oldest go first, so a capped tick is fair over time.
  const rows = await db.select({ id: users.id, needsReauth: users.needsReauth, last: sql<number | null>`MAX(${syncState.lastCycleAt})` })
    .from(users)
    .leftJoin(syncState, eq(syncState.userId, users.id))
    .groupBy(users.id, users.needsReauth)
    .orderBy(sql`MAX(${syncState.lastCycleAt}) IS NOT NULL`, sql`MAX(${syncState.lastCycleAt})`)
    .all();
  let ran = 0;
  for (const row of rows) {
    if (ran >= CRON_MAX_USERS) break;
    try {
      if (row.needsReauth || !isAllowed(env, row.id)) continue;
      const settings = await getSettings(db, row.id);
      if (!settings.planId) continue;
      ran++;
      const res = await runUserCycle(env, row.id, "cron");
      if (res.skipped === "error") {
        console.warn(JSON.stringify({ msg: "cron_cycle_error", codes: res.errors.map((e) => e.code) }));
      }
    } catch (e) {
      // One user's failure never stops the tick. No user data in logs (§16).
      console.error(JSON.stringify({ msg: "cron_cycle_failed", error: e instanceof Error ? e.name : "unknown" }));
    }
  }
}

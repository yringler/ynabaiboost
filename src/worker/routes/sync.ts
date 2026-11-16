// routes/sync.ts — WP3 (DESIGN §7): GET /api/plans, GET /api/catalog, POST /api/sync.
// Mounted at /api behind requireSession + requireAllowedUser (index.ts).
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { API } from "../../shared/api";
import { getSettings } from "../auth/settings";
import { syncState } from "../db/schema";
import type { AppEnv } from "../env";
import { runUserCycle, withUserLock } from "../jobs/cycle";
import { AppError } from "../lib/errors";
import { getAccounts, getCurrency, getRecentCategoryIds, getSelectableCategories, getTopPayees } from "../ynab/cache";
import { createYnabClient } from "../ynab/client";
import { syncPlan } from "../ynab/sync";

const TOP_PAYEES = 200;
const RECENT_CATEGORIES = 15;
/** How long /api/catalog waits for a cycle holding the lock before giving up. */
const CATALOG_LOCK_WAIT_MS = 5_000;

export const syncRoutes = new Hono<AppEnv>();

/** Live GET /plans. Also refreshes sync_state.plan_name for the user's known plans (Me.plan shows it). */
syncRoutes.get("/plans", async (c) => {
  const { db, userId } = c.var;
  const client = await createYnabClient(c.env, db, userId, "interactive");
  const plans = await client.listPlans();
  const known = await db.select({ planId: syncState.planId, planName: syncState.planName }).from(syncState)
    .where(and(eq(syncState.userId, userId), inArray(syncState.planId, plans.map((p) => p.id).slice(0, 90)))).all();
  const updates = known.flatMap((k) => {
    const name = plans.find((p) => p.id === k.planId)?.name;
    return name !== undefined && name !== k.planName
      ? [db.update(syncState).set({ planName: name }).where(and(eq(syncState.userId, userId), eq(syncState.planId, k.planId)))]
      : [];
  });
  const [first, ...rest] = updates;
  if (first) await db.batch([first, ...rest]);
  return c.json(API.plans.res.parse({ plans }));
});

/** From the cache. Runs the initial sync first (interactive) when the plan was never synced. */
syncRoutes.get("/catalog", async (c) => {
  const { db, userId } = c.var;
  const settings = await getSettings(db, userId);
  const planId = settings.planId;
  if (!planId) throw new AppError("no_plan_selected", "Choose a YNAB plan first");

  const knowledge = async () => (await db.select({ k: syncState.serverKnowledge }).from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.planId, planId))).get())?.k ?? null;
  if ((await knowledge()) === null) {
    const r = await withUserLock(c.env, db, userId, planId, async () => {
      if ((await knowledge()) !== null) return; // someone else finished the initial sync while we waited
      const client = await createYnabClient(c.env, db, userId, "interactive");
      await syncPlan(c.env, db, client, userId, planId);
    }, CATALOG_LOCK_WAIT_MS);
    if (r === "locked" && (await knowledge()) === null) throw new AppError("conflict", "A sync is already running. Try again in a moment.");
  }

  const [currency, categories, accounts, payees, recentCategoryIds] = await Promise.all([
    getCurrency(db, userId, planId),
    getSelectableCategories(db, userId, planId),
    getAccounts(db, userId, planId),
    getTopPayees(db, userId, planId, TOP_PAYEES),
    getRecentCategoryIds(db, userId, planId, RECENT_CATEGORIES),
  ]);
  return c.json(API.catalog.res.parse({
    planId,
    currency: { isoCode: currency.isoCode, decimalDigits: currency.decimalDigits },
    categories, accounts, payees, recentCategoryIds,
  }));
});

/** "Sync now" only (never on app open/focus). Errors come back in `errors` with skipped:"error", not as HTTP errors. */
syncRoutes.post("/sync", async (c) => {
  const result = await runUserCycle(c.env, c.var.userId, "manual");
  return c.json(API.sync.res.parse(result));
});

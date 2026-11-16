// WP3: withUserLock, runUserCycle (cron | manual | intent_create), runCron, the scheduled handler,
// and the /api/plans, /api/catalog, /api/sync routes. WP2/WP4/WP5 exports are mocked.
import { setupNetwork } from "@msw/cloudflare";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SyncResult, type Settings } from "../../src/shared/schemas";
import { CatalogRes, PlansRes } from "../../src/shared/api";
import { todayIn } from "../../src/shared/dates";
import { getDb } from "../../src/worker/db/client";
import { syncState, users } from "../../src/worker/db/schema";
import type { AppEnv, UserRow } from "../../src/worker/env";
import { PLAN_ID, seedPlan, txn } from "../fixtures/ynab/plan";
import { FakeYnab } from "../msw/ynab";

const m = vi.hoisted(() => ({
  allowed: new Set<string>(),
  settings: new Map<string, Partial<Settings>>(),
  reauth: new Set<string>(),
  isAllowed: vi.fn((_env: Env, id: string) => m.allowed.has(id)),
  getUser: vi.fn(async (_db: unknown, id: string): Promise<UserRow | null> =>
    ({ id, authType: "pat", sttAllowed: false, needsReauth: m.reauth.has(id), tokenRefreshLockUntil: null, createdAt: 1, lastSeenAt: 1 })),
  getSettings: vi.fn(async (_db: unknown, id: string) => ({ ...m.defaults, ...(m.settings.get(id) ?? {}) })),
  defaults: {} as Settings,
  getYnabAccessToken: vi.fn(async () => "tok"),
  markNeedsReauth: vi.fn(async () => undefined),
  reconcileUser: vi.fn(async (_ctx: unknown, _delta?: unknown) => ({ matched: 0, reviewsCreated: 0, stale: 0, errors: [] as string[] })),
}));
vi.mock("../../src/worker/auth/users", () => ({ isAllowed: m.isAllowed, getUser: m.getUser, isAdmin: () => false, upsertUser: vi.fn() }));
vi.mock("../../src/worker/auth/settings", () => ({ getSettings: m.getSettings, updateSettings: vi.fn() }));
vi.mock("../../src/worker/auth/ynabToken", () => ({ getYnabAccessToken: m.getYnabAccessToken, markNeedsReauth: m.markNeedsReauth }));
vi.mock("../../src/worker/engine/reconcile", () => ({ reconcileUser: m.reconcileUser, countOpen: vi.fn() }));

// index.ts loads the real modules before vi.mock applies: reset and import the modules under test afresh.
let Cy: typeof import("../../src/worker/jobs/cycle");
let R: typeof import("../../src/worker/routes/sync");
let L: typeof import("../../src/worker/lib/errors");
let Cl: typeof import("../../src/worker/ynab/client");
// Hono too: a sub-app's default error handler is recognised by identity with *its* hono module instance.
let H: typeof import("hono");
beforeAll(async () => {
  m.defaults = DEFAULT_SETTINGS;
  vi.resetModules();
  Cy = await import("../../src/worker/jobs/cycle");
  R = await import("../../src/worker/routes/sync");
  L = await import("../../src/worker/lib/errors");
  Cl = await import("../../src/worker/ynab/client");
  H = await import("hono");
});

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const db = getDb(env);
let n = 0;
let uid = "";
let fake: FakeYnab;

async function newUser(opts: { allowed?: boolean; plan?: string | null; settings?: Partial<Settings> } = {}): Promise<string> {
  const id = `cycle-user-${++n}`;
  await db.insert(users).values({ id, authType: "pat", createdAt: 1, lastSeenAt: 1 });
  if (opts.allowed ?? true) m.allowed.add(id);
  m.settings.set(id, { planId: opts.plan === undefined ? PLAN_ID : opts.plan, ...(opts.settings ?? {}) });
  return id;
}
const state = (id = uid) => db.select().from(syncState).where(and(eq(syncState.userId, id), eq(syncState.planId, PLAN_ID))).get();
const setState = (patch: Partial<typeof syncState.$inferInsert>, id = uid) =>
  db.update(syncState).set(patch).where(and(eq(syncState.userId, id), eq(syncState.planId, PLAN_ID)));

beforeEach(async () => {
  fake = new FakeYnab(seedPlan(todayIn("UTC")));
  network.use(...fake.handlers());
  vi.spyOn(Cl.backoff, "sleep").mockResolvedValue(undefined);
  m.reconcileUser.mockClear();
  m.reconcileUser.mockImplementation(async () => ({ matched: 0, reviewsCreated: 0, stale: 0, errors: [] }));
  uid = await newUser();
});

describe("withUserLock", () => {
  it("runs fn under the lock and releases it", async () => {
    const r = await Cy.withUserLock(env, db, uid, PLAN_ID, async () => {
      const s = await state();
      expect(s?.lockUntil).toBeGreaterThan(Date.now() + 100_000);
      return 42;
    });
    expect(r).toBe(42);
    expect((await state())?.lockUntil).toBeNull();
  });

  it("returns 'locked' immediately when held (waitMs 0) and never runs fn", async () => {
    const fn = vi.fn(async () => 1);
    const outer = await Cy.withUserLock(env, db, uid, PLAN_ID, async () => Cy.withUserLock(env, db, uid, PLAN_ID, fn));
    expect(outer).toBe("locked");
    expect(fn).not.toHaveBeenCalled();
  });

  it("polls until the holder releases (waitMs)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = Cy.withUserLock(env, db, uid, PLAN_ID, () => gate);
    await new Promise((r) => setTimeout(r, 50));
    const waiter = Cy.withUserLock(env, db, uid, PLAN_ID, async () => "second", 3_000);
    setTimeout(release, 300);
    expect(await waiter).toBe("second");
    await holder;
  });

  it("gives up after waitMs", async () => {
    await Cy.withUserLock(env, db, uid, PLAN_ID, async () => {
      const t0 = Date.now();
      expect(await Cy.withUserLock(env, db, uid, PLAN_ID, async () => 1, 600)).toBe("locked");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    });
  });

  it("releases on throw and takes over an expired lock", async () => {
    await expect(Cy.withUserLock(env, db, uid, PLAN_ID, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await state())?.lockUntil).toBeNull();
    await setState({ lockUntil: Date.now() - 1 });
    expect(await Cy.withUserLock(env, db, uid, PLAN_ID, async () => "ok")).toBe("ok");
  });

  it("does not release a lock that someone else re-took after ours expired", async () => {
    await Cy.withUserLock(env, db, uid, PLAN_ID, async () => {
      await setState({ lockUntil: 123 }); // simulates expiry + takeover by another holder
    });
    expect((await state())?.lockUntil).toBe(123);
  });
});

describe("runUserCycle", () => {
  it("manual: initial sync, reconcile with the delta; stores last_cycle_at", async () => {
    m.reconcileUser.mockResolvedValueOnce({ matched: 2, reviewsCreated: 1, stale: 3, errors: ["intent x: boom"] });
    const r = await Cy.runUserCycle(env, uid, "manual");
    expect(SyncResult.parse(r)).toEqual(r);
    expect(r).toMatchObject({ skipped: null, matched: 2, reviewsCreated: 1, stale: 3,
      errors: [{ code: "engine", message: "intent x: boom" }] });
    expect(r.changedTransactions).toBe(seedPlan(todayIn("UTC")).transactions.length);
    const [ctx, delta] = m.reconcileUser.mock.calls[0] as unknown as [Record<string, unknown>, { initial: boolean }];
    expect(delta.initial).toBe(true);
    expect(ctx).toMatchObject({ userId: uid, planId: PLAN_ID, actor: "user", currency: { isoCode: "USD", decimalDigits: 2 }, today: todayIn("UTC") });
    const s = await state();
    expect(s?.lastCycleAt).toBe(r.ranAt);
    expect(s?.lastError).toBe("engine: intent x: boom");
    expect(s?.lockUntil).toBeNull();
  });

  it("manual: throttled within 60 s, runs again after", async () => {
    await Cy.runUserCycle(env, uid, "manual");
    expect((await Cy.runUserCycle(env, uid, "manual")).skipped).toBe("throttled");
    await setState({ lastCycleAt: Date.now() - 61_000 });
    const r = await Cy.runUserCycle(env, uid, "manual");
    expect(r.skipped).toBeNull();
    expect(fake.requestsTo("GET", /^\/plans\/plan-1$/)).toHaveLength(1); // second run is a 1-request delta
  });

  it("intent_create is never throttled", async () => {
    await Cy.runUserCycle(env, uid, "manual");
    expect((await Cy.runUserCycle(env, uid, "intent_create")).skipped).toBeNull();
  });

  it("cron: no initial sync; 30 min throttle; actor cron", async () => {
    expect((await Cy.runUserCycle(env, uid, "cron")).skipped).toBe("no_plan");
    expect(fake.requests).toHaveLength(0);
    await Cy.runUserCycle(env, uid, "manual");
    expect((await Cy.runUserCycle(env, uid, "cron")).skipped).toBe("throttled");
    await setState({ lastCycleAt: Date.now() - 31 * 60_000 });
    const r = await Cy.runUserCycle(env, uid, "cron");
    expect(r).toMatchObject({ skipped: null });
    expect((m.reconcileUser.mock.calls.at(-1) as unknown as [{ actor: string }])[0].actor).toBe("cron");
  });

  it("skip reasons: not_allowed, reauth, no_plan, rate_limited, locked", async () => {
    const stranger = await newUser({ allowed: false });
    expect((await Cy.runUserCycle(env, stranger, "manual")).skipped).toBe("not_allowed");
    const re = await newUser();
    m.reauth.add(re);
    expect((await Cy.runUserCycle(env, re, "manual")).skipped).toBe("reauth");
    const noPlan = await newUser({ plan: null });
    expect((await Cy.runUserCycle(env, noPlan, "manual")).skipped).toBe("no_plan");

    await Cy.runUserCycle(env, uid, "manual");
    await setState({ lastCycleAt: 0, rateLimitedUntil: Date.now() + 60_000 });
    expect((await Cy.runUserCycle(env, uid, "manual")).skipped).toBe("rate_limited");
    await setState({ rateLimitedUntil: Date.now() - 1 });
    const inner = await Cy.withUserLock(env, db, uid, PLAN_ID, () => Cy.runUserCycle(env, uid, "manual"));
    expect(inner).toMatchObject({ skipped: "locked" });
    expect(fake.requests.filter((x) => x.path === "/plans/plan-1")).toHaveLength(0);
  });

  it("YNAB errors come back as skipped:error with the code, and land in last_error", async () => {
    fake.failNext("GET", /\/settings$/, 403, { id: "403.1" });
    const r = await Cy.runUserCycle(env, uid, "manual");
    expect(r.skipped).toBe("error");
    expect(r.errors[0]).toMatchObject({ code: "ynab_subscription_lapsed" });
    expect(m.reconcileUser).not.toHaveBeenCalled();
    expect((await state())?.lastError).toMatch(/^ynab_subscription_lapsed: /);
    expect((await state())?.lockUntil).toBeNull();

    await setState({ lastCycleAt: 0 });
    const ok = await Cy.runUserCycle(env, uid, "manual");
    expect(ok.skipped).toBeNull();
    expect((await state())?.lastError).toBeNull();
  });

  it("a 429 during the cycle sets the cooldown so the next cycle is skipped", async () => {
    await Cy.runUserCycle(env, uid, "manual");
    await setState({ lastCycleAt: 0 });
    fake.putTxn(PLAN_ID, txn("t-new", todayIn("UTC"), -1));
    fake.failNext("GET", /^\/plans\/plan-1$/, 429, { times: 2 });
    const r = await Cy.runUserCycle(env, uid, "manual");
    expect(r).toMatchObject({ skipped: "error", errors: [{ code: "ynab_rate_limited" }] });
    await setState({ lastCycleAt: 0 });
    expect((await Cy.runUserCycle(env, uid, "manual")).skipped).toBe("rate_limited");
  });

  it("unexpected errors are reported as internal without details", async () => {
    await Cy.runUserCycle(env, uid, "manual");
    await setState({ lastCycleAt: 0 });
    m.reconcileUser.mockRejectedValueOnce(new Error("secret stack detail"));
    const r = await Cy.runUserCycle(env, uid, "manual");
    expect(r).toMatchObject({ skipped: "error", errors: [{ code: "internal", message: "Unexpected error during sync" }] });
  });
});

describe("runCron and the scheduled handler", () => {
  async function readyUser(opts: Parameters<typeof newUser>[0] = {}) {
    const id = await newUser(opts);
    if (opts.plan !== null) {
      await db.insert(syncState).values({ userId: id, planId: PLAN_ID, serverKnowledge: 1, lastCycleAt: 0 }).onConflictDoNothing();
    }
    return id;
  }

  it("runs a cron cycle for each eligible user, sequentially, skipping the rest", async () => {
    const a = await readyUser();
    const b = await readyUser();
    const blocked = await readyUser({ allowed: false });
    const re = await readyUser();
    m.reauth.add(re);
    await db.update(users).set({ needsReauth: true }).where(eq(users.id, re));
    const noPlan = await readyUser({ plan: null });
    await Cy.runCron(env);
    const ran = m.reconcileUser.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId);
    expect(ran).toEqual(expect.arrayContaining([a, b]));
    expect(ran).not.toContain(blocked);
    expect(ran).not.toContain(re);
    expect(ran).not.toContain(noPlan);
    expect((await state(a))?.lastCycleAt).toBeGreaterThan(0);
  });

  it("one user's failure does not stop the others", async () => {
    const a = await readyUser();
    const b = await readyUser();
    m.reconcileUser.mockImplementation(async (ctx: unknown) => {
      if ((ctx as { userId: string }).userId === a) throw new Error("boom");
      return { matched: 1, reviewsCreated: 0, stale: 0, errors: [] };
    });
    await Cy.runCron(env);
    expect((await state(a))?.lastError).toMatch(/^internal: /);
    expect((await state(b))?.lastError).toBeNull();
  });

  it("the Worker's scheduled() export runs the cron for two users", async () => {
    const a = await readyUser();
    const b = await readyUser();
    const worker = (await import("../../src/worker/index")).default;
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 */6 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const ran = m.reconcileUser.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId);
    expect(ran).toEqual(expect.arrayContaining([a, b]));
  });
});

describe("routes /api/plans, /api/catalog, /api/sync", () => {
  const app = () => {
    const a = new H.Hono<AppEnv>();
    a.onError(L.errorHandler);
    a.use("*", async (c, next) => {
      c.set("db", getDb(c.env));
      c.set("userId", uid);
      await next();
    });
    a.route("/api", R.syncRoutes);
    return a;
  };
  const req = (path: string, init?: RequestInit) => app().request(`https://app.test${path}`, init, env);

  it("GET /api/plans lists plans live and records the plan name", async () => {
    await db.insert(syncState).values({ userId: uid, planId: PLAN_ID });
    const res = await req("/api/plans");
    expect(res.status).toBe(200);
    expect(PlansRes.parse(await res.json())).toEqual({ plans: [{ id: PLAN_ID, name: "My Plan" }] });
    expect((await state())?.planName).toBe("My Plan");
  });

  it("GET /api/plans maps YNAB errors to ApiErrorBody", async () => {
    fake.failNext("GET", /^\/plans$/, 401);
    const res = await req("/api/plans");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "ynab_reauth_required", message: expect.any(String) } });
    expect(m.markNeedsReauth).toHaveBeenCalled();
  });

  it("GET /api/catalog: no_plan_selected without a plan", async () => {
    m.settings.set(uid, { planId: null });
    const res = await req("/api/catalog");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "no_plan_selected" } });
  });

  it("GET /api/catalog runs the initial sync once, then serves from the cache", async () => {
    const res = await req("/api/catalog");
    expect(res.status).toBe(200);
    const body = CatalogRes.parse(await res.json());
    expect(body.planId).toBe(PLAN_ID);
    expect(body.currency).toEqual({ isoCode: "USD", decimalDigits: 2 });
    expect(body.categories.map((c) => c.id)).toEqual(["c-groceries", "c-dining", "c-electric"]);
    expect(body.accounts.map((a) => a.id).sort()).toEqual(["acc-cash", "acc-checking", "acc-visa"]);
    expect(body.payees[0]?.id).toBe("p-costco");
    expect(body.recentCategoryIds).toEqual(["c-groceries", "c-dining", "c-electric"]);
    expect(fake.requests).toHaveLength(5);
    expect((await state())?.lockUntil).toBeNull();

    const again = await req("/api/catalog");
    expect(again.status).toBe(200);
    expect(fake.requests).toHaveLength(5);
  });

  it("GET /api/catalog: 409 conflict when another sync holds the lock past the wait", async () => {
    await db.insert(syncState).values({ userId: uid, planId: PLAN_ID, lockUntil: Date.now() + 60_000 });
    const res = await req("/api/catalog");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "conflict" } });
  }, 15_000);

  it("POST /api/sync runs a manual cycle and returns a SyncResult; errors stay in the body", async () => {
    const res = await req("/api/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = SyncResult.parse(await res.json());
    expect(body.skipped).toBeNull();
    const again = SyncResult.parse(await (await req("/api/sync", { method: "POST" })).json());
    expect(again.skipped).toBe("throttled");

    await setState({ lastCycleAt: 0 });
    fake.failNext("GET", /^\/plans\/plan-1$/, 403, { id: "403.2" });
    const failed = await req("/api/sync", { method: "POST" });
    expect(failed.status).toBe(200);
    expect(SyncResult.parse(await failed.json())).toMatchObject({ skipped: "error", errors: [{ code: "ynab_subscription_lapsed" }] });
  });
});

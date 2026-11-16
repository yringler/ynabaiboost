// Review regression: PATCH /api/intents/:id must apply the §10.7 "still untouched" guard before writing the placeholder.
import { env } from "cloudflare:workers";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn } from "../../../src/shared/dates";
import type { AppEnv } from "../../../src/worker/env";
import { FakeYnab, cacheTxns, mkTxn, seedIntent, seedUser, uid } from "../wp5-helpers";

const m = vi.hoisted(() => ({ fake: null as unknown, userId: "" }));
vi.mock("../../../src/worker/auth/settings", async () => {
  const { DEFAULT_SETTINGS } = await import("../../../src/shared/schemas");
  return { getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, planId: "plan-1", timezone: "UTC" })), updateSettings: vi.fn() };
});
vi.mock("../../../src/worker/ynab/client", () => ({ createYnabClient: vi.fn(async () => m.fake), createYnabClientForToken: vi.fn() }));
vi.mock("../../../src/worker/jobs/cycle", () => ({
  withUserLock: vi.fn(async (_e: unknown, _d: unknown, _u: unknown, _p: unknown, fn: () => Promise<unknown>) => fn()),
  runUserCycle: vi.fn(), runCron: vi.fn(),
}));

let app: Hono<AppEnv>;
let T: typeof import("../../../src/worker/domain/tolerance");
beforeAll(async () => {
  vi.resetModules();
  const H = await import("hono");
  const E = await import("../../../src/worker/lib/errors");
  T = await import("../../../src/worker/domain/tolerance");
  const { intentRoutes } = await import("../../../src/worker/routes/intents");
  const { getDb } = await import("../../../src/worker/db/client");
  app = new H.Hono<AppEnv>();
  app.onError(E.errorHandler);
  app.use("*", async (c, next) => {
    c.set("db", getDb(c.env));
    c.set("userId", m.userId);
    await next();
  });
  app.route("/api", intentRoutes);
});

const TODAY = todayIn("UTC");
let fake: FakeYnab;
let userId: string;
beforeEach(async () => {
  userId = uid("user");
  m.userId = userId;
  fake = new FakeYnab();
  m.fake = fake;
  await seedUser(userId);
});

describe("PATCH /api/intents/:id", () => {
  it("does not overwrite amount/memo of a placeholder YNAB already merged with a cleared bank import", async () => {
    // YNAB merged our exact-amount placeholder with the bank import before the next 6-hourly cron sync,
    // so D1 still says placeholder_status='created' and the cache still shows the untouched placeholder.
    const phId = uid("ph");
    const merged = mkTxn({
      id: phId, date: addDays(TODAY, -1), amount: -84120, importId: "YNAB:-84120:x:1", importPayeeName: "COSTCO WHSE #0123",
      cleared: "cleared", approved: true, categoryId: "cat-groceries", memo: "bank memo | groceries [aib:REV001]",
    });
    fake.seed(merged);
    await cacheTxns(userId, [{ ...merged, importId: null, cleared: "uncleared", importPayeeName: null }]);
    const i = await seedIntent(userId, {
      payee: "Costco", total: 84120, approximate: false, date: addDays(TODAY, -1), shortRef: "REV001",
      placeholderTxnId: phId, placeholderStatus: "created", placeholderAmount: 84120,
    }, (a, x) => T.computeTolerance(a, x));

    // The user corrects the amount they typed.
    const res = await app.request(`https://app.test/api/intents/${i.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ totalAmount: 84210 }),
    }, env);
    expect(res.status).toBe(200);

    const after = fake.txns.get(phId)!;
    expect(after.amount).toBe(-84120);                         // the bank's amount
    expect(after.memo).toContain("bank memo");                 // the import's memo survives
  });
});

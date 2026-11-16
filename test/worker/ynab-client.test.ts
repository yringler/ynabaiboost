// WP3: YNAB error mapping, backoffFetch, and the YnabClient over the ynab@5 SDK against FakeYnab (msw).
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { todayIn } from "../../src/shared/dates";
import { getDb } from "../../src/worker/db/client";
import { syncState, users } from "../../src/worker/db/schema";
import { PLAN_ID, seedPlan, txn } from "../fixtures/ynab/plan";
import { FakeYnab } from "../msw/ynab";

const mocks = vi.hoisted(() => ({
  getYnabAccessToken: vi.fn(async () => "tok-1"),
  markNeedsReauth: vi.fn(async () => undefined),
}));
vi.mock("../../src/worker/auth/ynabToken", () => mocks);

// The worker entry (index.ts) is loaded before vi.mock applies, so its module graph holds the real WP2 modules.
// Reset the registry and import the modules under test afresh so they see the mocks.
let C: typeof import("../../src/worker/ynab/client");
let E: typeof import("../../src/worker/ynab/errors");
let L: typeof import("../../src/worker/lib/errors");
beforeAll(async () => {
  vi.resetModules();
  C = await import("../../src/worker/ynab/client");
  E = await import("../../src/worker/ynab/errors");
  L = await import("../../src/worker/lib/errors");
});

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

let fake: FakeYnab;
beforeEach(() => {
  fake = new FakeYnab(seedPlan(todayIn("UTC")));
  network.use(...fake.handlers());
  vi.spyOn(C.backoff, "sleep").mockResolvedValue(undefined);
  mocks.getYnabAccessToken.mockClear();
  mocks.markNeedsReauth.mockClear();
});

const err = (status: number, id = String(status)) => new E.YnabApiError(status, { id, name: "x", detail: "d" });

describe("errors", () => {
  it("isYnabErrorBody", () => {
    expect(E.isYnabErrorBody({ error: { id: "401", name: "unauthorized", detail: "x" } })).toBe(true);
    expect(E.isYnabErrorBody({ error: { id: 401 } })).toBe(false);
    expect(E.isYnabErrorBody(null)).toBe(false);
    expect(E.isYnabErrorBody("x")).toBe(false);
  });
  it("toAppError maps statuses and sub-codes", () => {
    expect(E.toAppError(err(401)).code).toBe("ynab_reauth_required");
    expect(E.toAppError(err(403, "403.1")).code).toBe("ynab_subscription_lapsed");
    expect(E.toAppError(err(403, "403.2")).code).toBe("ynab_subscription_lapsed");
    expect(E.toAppError(err(403, "403.3")).code).toBe("ynab_error");
    expect(E.toAppError(err(429)).code).toBe("ynab_rate_limited");
    expect(E.toAppError(err(500)).code).toBe("ynab_error");
    expect(E.toAppError(err(404, "404.2")).status).toBe(502);
  });
  it("asYnabApiError unwraps FetchError causes and raw bodies", () => {
    const e = err(429);
    expect(E.asYnabApiError(e)).toBe(e);
    expect(E.asYnabApiError(new Error("wrapped", { cause: e }))).toBe(e);
    expect(E.asYnabApiError({ error: { id: "403.1", name: "n", detail: "d" } })?.status).toBe(403);
    expect(E.asYnabApiError(new Error("network"))).toBeNull();
  });
});

describe("backoffFetch", () => {
  const seq = (...statuses: number[]) => {
    const calls: number[] = [];
    const f: typeof fetch = async () => {
      const s = statuses[Math.min(calls.length, statuses.length - 1)] ?? 200;
      calls.push(s);
      return s === 200 ? Response.json({ ok: true }) : Response.json({ error: { id: String(s), name: "n", detail: "d" } }, { status: s });
    };
    return { f, calls };
  };
  it("interactive retries a 429 once (≈1 s) then fails with the YNAB error", async () => {
    const { f, calls } = seq(429, 429, 200);
    await expect(C.backoffFetch("interactive", f)("https://api.ynab.com/v1/user")).rejects.toMatchObject({ status: 429 });
    expect(calls).toEqual([429, 429]);
    const waits = vi.mocked(C.backoff.sleep).mock.calls.map(([ms]) => ms);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(750);
    expect(waits[0]).toBeLessThanOrEqual(1250);
  });
  it("background backs off 1 s then 4 s", async () => {
    const { f, calls } = seq(429, 429, 200);
    const res = await C.backoffFetch("background", f)("https://api.ynab.com/v1/user");
    expect(res.status).toBe(200);
    expect(calls).toEqual([429, 429, 200]);
    const waits = vi.mocked(C.backoff.sleep).mock.calls.map(([ms]) => ms);
    expect(waits[1]).toBeGreaterThanOrEqual(3000);
    expect(waits[1]).toBeLessThanOrEqual(5000);
  });
  it("retries a 503 once", async () => {
    const ok = seq(503, 200);
    expect((await C.backoffFetch("interactive", ok.f)("https://x")).status).toBe(200);
    const bad = seq(503, 503, 200);
    await expect(C.backoffFetch("background", bad.f)("https://x")).rejects.toMatchObject({ status: 503 });
    expect(bad.calls).toEqual([503, 503]);
  });
  it("non-JSON error bodies still become YnabApiError", async () => {
    const f: typeof fetch = async () => new Response("<html>bad gateway</html>", { status: 502 });
    await expect(C.backoffFetch("interactive", f)("https://x")).rejects.toMatchObject({ status: 502, id: "502", name: "http_error" });
  });
});

describe("YnabClient over the SDK", () => {
  const client = () => C.createYnabClientForToken("tok-abc");

  it("sends the bearer token; getUserId, listPlans, getPlanSettings", async () => {
    const c = client();
    expect(await c.getUserId()).toBe("ynab-user-1");
    expect(await c.listPlans()).toEqual([{ id: PLAN_ID, name: "My Plan" }]);
    expect(await c.getPlanSettings(PLAN_ID)).toEqual({ isoCode: "USD", decimalDigits: 2 });
    expect(fake.requests[0]?.auth).toBe("Bearer tok-abc");
  });

  it("getCategories flattens groups with a global sort order", async () => {
    const r = await client().getCategories(PLAN_ID);
    expect(r.serverKnowledge).toBe(fake.knowledge);
    expect(r.groups.map((g) => g.id)).toContain("g-hidden");
    const groceries = r.items.find((c) => c.id === "c-groceries");
    const electric = r.items.find((c) => c.id === "c-electric");
    expect(groceries).toMatchObject({ groupId: "g-everyday", hidden: false, deleted: false });
    expect(groceries!.sortIndex).toBeLessThan(electric!.sortIndex);
  });

  it("getAccounts keeps direct_import_linked; getPayees keeps transfer accounts", async () => {
    const a = await client().getAccounts(PLAN_ID);
    expect(a.items.find((x) => x.id === "acc-cash")).toMatchObject({ directImportLinked: false, type: "cash", onBudget: true });
    expect(a.items.find((x) => x.id === "acc-checking")?.directImportLinked).toBe(true);
    const p = await client().getPayees(PLAN_ID, 5);
    expect(fake.requests.at(-1)?.search.get("last_knowledge_of_server")).toBe("5");
    expect(p.items.find((x) => x.id === "tp-acc-checking")?.transferAccountId).toBe("acc-checking");
  });

  it("getTransactionsSince converts TransactionDetail (payee name, split flag, import names)", async () => {
    const r = await client().getTransactionsSince(PLAN_ID, "2000-01-01");
    expect(fake.requests.at(-1)?.search.get("since_date")).toBe("2000-01-01");
    const split = r.items.find((t) => t.id === "t-split");
    expect(split).toMatchObject({ isSplit: true, payeeName: "Amazon", planId: PLAN_ID });
    expect(r.items.find((t) => t.id === "t-costco-1")).toMatchObject({
      amount: -120_000, payeeName: "Costco", importPayeeNameOriginal: "COSTCO WHSE #0123", importId: "YNAB:-120000:1",
      accountId: "acc-visa", categoryId: "c-groceries", cleared: "cleared", approved: true, flagColor: null, deleted: false,
    });
  });

  it("getPlanDelta returns only changes and fills payee names from the delta", async () => {
    const k0 = fake.knowledge;
    fake.putPayee(PLAN_ID, { id: "p-new", name: "New Shop", transfer_account_id: null, deleted: false });
    fake.putTxn(PLAN_ID, txn("t-new", todayIn("UTC"), -1_000, { payee_id: "p-new" }));
    fake.putTxn(PLAN_ID, txn("t-old-payee", todayIn("UTC"), -2_000, { payee_id: "p-costco", flag_color: "" }));
    fake.updateTxn(PLAN_ID, "t-sbux-1", { deleted: true });
    const d = await client().getPlanDelta(PLAN_ID, k0);
    expect(d.serverKnowledge).toBe(fake.knowledge);
    expect(d.transactions.map((t) => t.id).sort()).toEqual(["t-new", "t-old-payee", "t-sbux-1"]);
    expect(d.transactions.find((t) => t.id === "t-new")?.payeeName).toBe("New Shop");
    expect(d.transactions.find((t) => t.id === "t-old-payee")).toMatchObject({ payeeName: null, flagColor: null }); // filled by syncPlan
    expect(d.transactions.find((t) => t.id === "t-sbux-1")?.deleted).toBe(true);
    expect(d.payees).toEqual([{ id: "p-new", name: "New Shop", transferAccountId: null, deleted: false }]);
    expect(d.categories).toEqual([]);
  });

  it("getPlanDelta flags split parents from the subtransactions array", async () => {
    const k0 = fake.knowledge;
    fake.updateTxn(PLAN_ID, "t-split", { memo: "changed" });
    fake.putSub(PLAN_ID, { id: "s-3", transaction_id: "t-split", amount: 0, memo: null, payee_id: null, category_id: "c-dining", transfer_account_id: null, deleted: false });
    const d = await client().getPlanDelta(PLAN_ID, k0);
    expect(d.transactions.find((t) => t.id === "t-split")?.isSplit).toBe(true);
  });

  it("getTransaction returns null on 404", async () => {
    expect(await client().getTransaction(PLAN_ID, "nope")).toBeNull();
    expect((await client().getTransaction(PLAN_ID, "t-sbux-2"))?.payeeName).toBe("Starbucks");
  });

  it("createTransaction posts uncleared, no import_id, payee by id or name", async () => {
    const c = client();
    const created = await c.createTransaction(PLAN_ID, {
      accountId: "acc-checking", date: "2026-11-15", amount: -199_990, payeeId: null, payeeName: "Costco",
      categoryId: "c-groceries", memo: "≈ stuff [aib:K3F9QX]", approved: true, flagColor: "purple",
    });
    const body = fake.requestsTo("POST", /\/transactions$/).at(-1)?.body as { transaction: Record<string, unknown> };
    expect(body.transaction).toEqual({
      account_id: "acc-checking", date: "2026-11-15", amount: -199_990, payee_name: "Costco", category_id: "c-groceries",
      memo: "≈ stuff [aib:K3F9QX]", cleared: "uncleared", approved: true, flag_color: "purple",
    });
    expect(created).toMatchObject({ amount: -199_990, cleared: "uncleared", importId: null, payeeId: "p-costco", payeeName: "Costco" });

    await c.createTransaction(PLAN_ID, {
      accountId: "acc-cash", date: "2026-11-15", amount: -30_000, payeeId: "p-starbucks", payeeName: null, categoryId: "c-dining",
      memo: null, approved: true, flagColor: null,
      subtransactions: [{ amount: -20_000, categoryId: "c-dining", memo: "a" }, { amount: -10_000, categoryId: "c-groceries", memo: null }],
    });
    const body2 = fake.requestsTo("POST", /\/transactions$/).at(-1)?.body as { transaction: Record<string, unknown> };
    expect(body2.transaction).toMatchObject({ payee_id: "p-starbucks", category_id: null,
      subtransactions: [{ amount: -20_000, category_id: "c-dining", memo: "a" }, { amount: -10_000, category_id: "c-groceries", memo: null }] });
    expect(body2.transaction).not.toHaveProperty("payee_name");
    expect(body2.transaction).not.toHaveProperty("import_id");
  });

  it("updateTransactions sends one bulk PATCH with only the given fields", async () => {
    const out = await client().updateTransactions(PLAN_ID, [
      { id: "t-sbux-2", categoryId: "c-dining", approved: true, flagColor: "purple" },
      { id: "t-uncat", memo: "x", subtransactions: [{ amount: -5_000, categoryId: "c-groceries", memo: null }, { amount: -4_990, categoryId: "c-dining", memo: null }] },
    ]);
    const patches = fake.requestsTo("PATCH", /\/transactions$/);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ transactions: [
      { id: "t-sbux-2", category_id: "c-dining", approved: true, flag_color: "purple" },
      { id: "t-uncat", memo: "x", category_id: null, subtransactions: [
        { amount: -5_000, category_id: "c-groceries", memo: null }, { amount: -4_990, category_id: "c-dining", memo: null }] },
    ] });
    expect(out.map((t) => t.id)).toEqual(["t-sbux-2", "t-uncat"]);
    expect(out[1]?.isSplit).toBe(true);
    expect(await client().updateTransactions(PLAN_ID, [])).toEqual([]);
  });

  it("deleteTransaction treats 404 as success", async () => {
    const c = client();
    await c.deleteTransaction(PLAN_ID, "t-sbux-2");
    await c.deleteTransaction(PLAN_ID, "t-sbux-2");
    await c.deleteTransaction(PLAN_ID, "never-existed");
    expect(fake.requestsTo("DELETE", /transactions\//)).toHaveLength(3);
  });

  it("maps YNAB errors to AppError", async () => {
    fake.failNext("GET", /^\/plans$/, 403, { id: "403.1" });
    await expect(client().listPlans()).rejects.toMatchObject({ code: "ynab_subscription_lapsed" });
    fake.failNext("GET", /^\/plans$/, 500);
    const e = await client().listPlans().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(L.AppError);
    expect(e).toMatchObject({ code: "ynab_error" });
    fake.failNext("GET", /^\/plans$/, 404, { id: "404.1" });
    await expect(client().listPlans()).rejects.toMatchObject({ code: "ynab_error" });
  });

  it("interactive client fails fast on repeated 429", async () => {
    fake.failNext("GET", /^\/user$/, 429, { times: 2 });
    await expect(client().getUserId()).rejects.toMatchObject({ code: "ynab_rate_limited" });
    expect(fake.requestsTo("GET", /^\/user$/)).toHaveLength(2);
  });

  it("background client recovers after two 429s", async () => {
    fake.failNext("GET", /^\/user$/, 429, { times: 2 });
    expect(await C.createYnabClientWith("t", { kind: "background" }).getUserId()).toBe("ynab-user-1");
    expect(fake.requestsTo("GET", /^\/user$/)).toHaveLength(3);
  });
});

describe("createYnabClient side effects", () => {
  const db = getDb(env);
  const uid = "user-client-se";
  beforeAll(async () => {
    await db.insert(users).values({ id: uid, authType: "pat", createdAt: 1, lastSeenAt: 1 }).onConflictDoNothing();
    await db.insert(syncState).values([{ userId: uid, planId: PLAN_ID }, { userId: uid, planId: "plan-2" }]).onConflictDoNothing();
  });

  it("uses getYnabAccessToken", async () => {
    const c = await C.createYnabClient(env, db, uid, "interactive");
    await c.getUserId();
    expect(mocks.getYnabAccessToken).toHaveBeenCalledWith(env, db, uid);
    expect(fake.requests.at(-1)?.auth).toBe("Bearer tok-1");
  });

  it("401 marks the user as needing reauth", async () => {
    fake.failNext("GET", /^\/plans$/, 401);
    const c = await C.createYnabClient(env, db, uid, "interactive");
    await expect(c.listPlans()).rejects.toMatchObject({ code: "ynab_reauth_required" });
    expect(mocks.markNeedsReauth).toHaveBeenCalledWith(db, uid);
  });

  it("429 after backoff sets rate_limited_until ≈ now + 15 min on every plan of the user", async () => {
    fake.failNext("GET", /^\/plans\/plan-1$/, 429, { times: 3 });
    const c = await C.createYnabClient(env, db, uid, "background");
    const before = Date.now();
    await expect(c.getPlanDelta(PLAN_ID, 1)).rejects.toMatchObject({ code: "ynab_rate_limited" });
    const rows = await db.select().from(syncState).where(eq(syncState.userId, uid)).all();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.rateLimitedUntil).toBeGreaterThanOrEqual(before + 15 * 60_000);
      expect(r.rateLimitedUntil).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    }
    expect(mocks.markNeedsReauth).not.toHaveBeenCalled();
  });
});

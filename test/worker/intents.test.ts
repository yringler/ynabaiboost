// WP5 /api/intents* routes on a test app (the WP5 routers behind a stub session middleware), real D1,
// FakeYnab for YNAB. WP2 getSettings, WP3 createYnabClient / syncPlan / withUserLock are mocked.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn } from "../../src/shared/dates";
import { CandidatesRes, CreateIntentsRes, IntentRes, IntentsRes } from "../../src/shared/api";
import { auditLog, intentLines, intents, matches, reviews } from "../../src/worker/db/schema";
import type { AppEnv } from "../../src/worker/env";
import type { YnabTxn } from "../../src/worker/ynab/types";
import { FakeYnab, cacheTxns, db, mkTxn, seedIntent, seedUser, uid } from "./wp5-helpers";

const m = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  fake: null as unknown,
  imports: [] as unknown[],
  locked: false,
  syncFails: null as null | (() => Error),
  clientFails: null as null | (() => Error),
  userId: "",
}));
vi.mock("../../src/worker/auth/settings", async () => {
  const { DEFAULT_SETTINGS } = await import("../../src/shared/schemas");
  return { getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, planId: "plan-1", timezone: "UTC", ...m.settings })), updateSettings: vi.fn() };
});
vi.mock("../../src/worker/ynab/client", () => ({
  createYnabClient: vi.fn(async () => {
    if (m.clientFails) throw m.clientFails();
    return m.fake;
  }),
  createYnabClientForToken: vi.fn(),
}));
vi.mock("../../src/worker/ynab/sync", () => ({
  syncPlan: vi.fn(async (_e: unknown, _db: unknown, _c: unknown, userId: string) => {
    if (m.syncFails) throw m.syncFails();
    const h = await import("./wp5-helpers");
    const txns = m.imports as YnabTxn[];
    await h.cacheTxns(userId, txns);
    for (const t of txns) (m.fake as FakeYnab).seed(t);
    m.imports = [];
    return { initial: false, changedTxnIds: txns.map((t) => t.id), deletedTxnIds: [], serverKnowledge: 2 };
  }),
}));
vi.mock("../../src/worker/jobs/cycle", () => ({
  withUserLock: vi.fn(async (_e: unknown, _d: unknown, _u: unknown, _p: unknown, fn: () => Promise<unknown>) => (m.locked ? "locked" : fn())),
  runUserCycle: vi.fn(), runCron: vi.fn(),
}));

let app: Hono<AppEnv>;
let E: typeof import("../../src/worker/lib/errors");
let T: typeof import("../../src/worker/domain/tolerance");
beforeAll(async () => {
  vi.resetModules();
  const H = await import("hono");
  E = await import("../../src/worker/lib/errors");
  T = await import("../../src/worker/domain/tolerance");
  const { intentRoutes } = await import("../../src/worker/routes/intents");
  const { getDb } = await import("../../src/worker/db/client");
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
const YESTERDAY = addDays(TODAY, -1);
let fake: FakeYnab;
let userId: string;

beforeEach(async () => {
  userId = uid("user");
  m.userId = userId;
  fake = new FakeYnab();
  m.fake = fake;
  m.imports = [];
  m.locked = false;
  m.syncFails = null;
  m.clientFails = null;
  m.settings = {};
  await seedUser(userId);
});

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {} };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(`https://app.test${path}`, init, env);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const draft = (over: Record<string, unknown> = {}) => ({
  payee: "Costco", payeeId: null, merchantKind: "in_person", direction: "outflow", date: YESTERDAY, accountId: "acc-card",
  accountExplicit: false, totalAmount: 200000, approximate: true, memo: null, createPlaceholder: true,
  lines: [{ description: "groceries", categoryId: "cat-groceries", amount: null, approximate: true, confidence: null }],
  ...over,
});
const create = (...ds: Record<string, unknown>[]) => req("POST", "/api/intents", { intents: ds, rawText: "costco about 200", inputMode: "typed" });
const seed = (s: Parameters<typeof seedIntent>[1]) => seedIntent(userId, s, (a, x) => T.computeTolerance(a, x));
const row = async (id: string) => (await db().select().from(intents).where(eq(intents.id, id)).get())!;

describe("POST /api/intents (§10.7)", () => {
  it("no import yet → intent pending with a placeholder", async () => {
    const r = await create(draft());
    expect(r.status).toBe(200);
    const body = CreateIntentsRes.parse(r.json);
    expect(body.warnings).toEqual([]);
    const [i] = body.intents;
    expect(i).toMatchObject({
      status: "pending", payee: "Costco", totalAmount: 200000, tolerance: 50000, approximate: true, rawText: "costco about 200",
      placeholder: { status: "created", amount: 199990 }, isStale: false, expiresOn: addDays(YESTERDAY, 14),
    });
    expect(i?.lines).toEqual([expect.objectContaining({ amount: 200000, tolerance: 50000, categoryId: "cat-groceries", status: "open" })]);
    expect(fake.callsOf("createTransaction")).toHaveLength(1);
    const audits = await db().select().from(auditLog).where(eq(auditLog.intentId, i!.id)).all();
    expect(audits.map((a) => a.action).sort()).toEqual(["intent_created", "placeholder_created"]);
  });

  it("the import is already in YNAB → matched at creation, no placeholder POST", async () => {
    m.imports = [mkTxn({ id: uid("imp"), date: YESTERDAY, amount: -187650, importPayeeName: "COSTCO WHSE #0123" })];
    const body = CreateIntentsRes.parse((await create(draft())).json);
    expect(body.intents[0]).toMatchObject({ status: "resolved", placeholder: { status: "none" } });
    expect(body.intents[0]?.matchedTransactionIds).toHaveLength(1);
    expect(fake.callsOf("createTransaction")).toHaveLength(0);
    expect(fake.callsOf("updateTransactions")).toHaveLength(1);
  });

  it("a likely existing match opens a review: no placeholder, warning", async () => {
    m.imports = [
      mkTxn({ id: uid("a"), date: YESTERDAY, amount: -190000, importPayeeName: "COSTCO WHSE" }),
      mkTxn({ id: uid("b"), date: YESTERDAY, amount: -191000, importPayeeName: "COSTCO WHSE" }),
    ];
    const body = CreateIntentsRes.parse((await create(draft())).json);
    expect(body.intents[0]).toMatchObject({ status: "review", placeholder: { status: "none" } });
    expect(body.warnings).toEqual(["Costco: possible existing match, check Review"]);
    expect(fake.callsOf("createTransaction")).toHaveLength(0);
  });

  it("only the new intents are reconciled", async () => {
    const old = await seed({ payee: "Shell", total: 40000, date: YESTERDAY });
    m.imports = [mkTxn({ id: uid("s"), date: YESTERDAY, amount: -40000, importPayeeName: "SHELL OIL" })];
    await create(draft());
    expect((await row(old.id)).status).toBe("pending");
  });

  it("cash account → final entry, resolved", async () => {
    const body = CreateIntentsRes.parse((await create(draft({ accountId: "acc-cash", accountExplicit: true }))).json);
    expect(body.intents[0]).toMatchObject({ status: "resolved", placeholder: { status: "final", amount: 200000 }, accountExplicit: true });
  });

  it("createPlaceholder=false or settings.createPlaceholders=false → no placeholder", async () => {
    await create(draft({ createPlaceholder: false }));
    m.settings = { createPlaceholders: false };
    await create(draft());
    expect(fake.callsOf("createTransaction")).toHaveLength(0);
  });

  it("several intents and lines: line amounts and tolerances, order kept", async () => {
    const body = CreateIntentsRes.parse((await create(
      draft({ payee: "Target", totalAmount: 50000, approximate: false, lines: [
        { description: "lamp", categoryId: "cat-home", amount: 30000, approximate: false, confidence: "high" },
        { description: "lego", categoryId: "cat-kids", amount: 20000, approximate: true, confidence: null },
      ] }),
      draft({ payee: "Amazon", merchantKind: "amazon", totalAmount: 15000 }),
    )).json);
    expect(body.intents.map((i) => i.payee)).toEqual(["Target", "Amazon"]);
    expect(body.intents[0]?.lines.map((l) => [l.amount, l.tolerance, l.approximate])).toEqual([[30000, 1000, false], [20000, 5000, true]]);
    expect(body.intents[1]?.expiresOn).toBe(addDays(YESTERDAY, 21)); // the Amazon window outlives staleAfterDays
    expect(body.intents[0]?.shortRef).toMatch(/^[0-9A-Z]{6}$/);
  });

  it("lock held by a cycle → intents inserted, placeholders created, 'Synced later'", async () => {
    m.locked = true;
    m.imports = [mkTxn({ id: uid("imp"), date: YESTERDAY, amount: -187650, importPayeeName: "COSTCO WHSE" })];
    const body = CreateIntentsRes.parse((await create(draft())).json);
    expect(body.warnings).toContain("Synced later");
    expect(body.intents[0]).toMatchObject({ status: "pending", placeholder: { status: "created" } });
  });

  it("sync failure still records the intent", async () => {
    m.syncFails = () => new E.AppError("ynab_rate_limited", "slow");
    const body = CreateIntentsRes.parse((await create(draft())).json);
    expect(body.intents[0]?.status).toBe("pending");
    expect(body.warnings[0]).toMatch(/ynab_rate_limited/);
  });

  it("YNAB unreachable → intent recorded without placeholder", async () => {
    m.clientFails = () => new E.AppError("ynab_reauth_required", "again");
    const body = CreateIntentsRes.parse((await create(draft())).json);
    expect(body.intents[0]?.placeholder.status).toBe("none");
    expect(body.warnings[0]).toMatch(/ynab_reauth_required/);
  });

  it("placeholder failure → intent created, placeholder failed, warning", async () => {
    fake.failNext("createTransaction", () => new E.AppError("ynab_error", "nope"));
    const body = CreateIntentsRes.parse((await create(draft())).json);
    expect(body.intents[0]?.placeholder.status).toBe("failed");
    expect(body.warnings[0]).toMatch(/placeholder could not be created/);
  });

  it("validation: several lines need amounts; ApiErrorBody", async () => {
    const r = await create(draft({ lines: [
      { description: "a", categoryId: "c", amount: null, approximate: true, confidence: null },
      { description: "b", categoryId: "c", amount: 1000, approximate: true, confidence: null },
    ] }));
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: { code: "validation" } });
  });

  it("no plan selected → 409", async () => {
    m.settings = { planId: null };
    expect((await create(draft())).json).toMatchObject({ error: { code: "no_plan_selected" } });
  });
});

describe("GET /api/intents", () => {
  it("filters open / stale / resolved / cancelled; owner only", async () => {
    const a = await seed({ payee: "A", total: 1000 });
    const b = await seed({ payee: "B", total: 1000, status: "review", expiresOn: addDays(TODAY, -1) });
    const c = await seed({ payee: "C", total: 1000, status: "resolved", resolvedAt: Date.now() });
    await seed({ payee: "Old", total: 1000, status: "resolved", resolvedAt: Date.now() - 40 * 86_400_000 });
    const d = await seed({ payee: "D", total: 1000, status: "cancelled" });
    const ids = async (q: string) => IntentsRes.parse((await req("GET", `/api/intents${q}`)).json).intents.map((i) => i.id).sort();
    expect(await ids("")).toEqual([a.id, b.id].sort());
    expect(await ids("?status=stale")).toEqual([b.id]);
    expect(await ids("?status=resolved")).toEqual([c.id]);
    expect(await ids("?status=cancelled")).toEqual([d.id]);
    const one = IntentRes.parse((await req("GET", `/api/intents/${b.id}`)).json).intent;
    expect(one.isStale).toBe(true);
    m.userId = uid("someone-else");
    expect((await req("GET", `/api/intents/${a.id}`)).status).toBe(404);
  });
  it("rejects an unknown status", async () => {
    expect((await req("GET", "/api/intents?status=bogus")).status).toBe(400);
  });
});

describe("PATCH /api/intents/:id", () => {
  it("recomputes tolerance and updates the placeholder (amount, date, category, memo)", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    const r = await req("PATCH", `/api/intents/${created.id}`, {
      totalAmount: 150000, date: addDays(TODAY, -3), memo: "bulk",
      lines: [{ description: "meat", categoryId: "cat-groceries", amount: 150000, approximate: true, confidence: null }],
    });
    expect(r.status).toBe(200);
    const i = IntentRes.parse(r.json).intent;
    expect(i).toMatchObject({ totalAmount: 150000, tolerance: 25000, memo: "bulk", date: addDays(TODAY, -3), placeholder: { amount: 149990 } });
    expect(fake.callsOf("updateTransactions")[0]?.args[1]).toEqual([{
      id: created.placeholder.txnId, amount: -149990, date: addDays(TODAY, -3), categoryId: "cat-groceries", memo: `≈ bulk [aib:${created.shortRef}]`,
    }]);
  });
  it("changing the account replaces the placeholder", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    const i = IntentRes.parse((await req("PATCH", `/api/intents/${created.id}`, { accountId: "acc-cash" })).json).intent;
    expect(fake.callsOf("deleteTransaction")).toHaveLength(1);
    expect(i).toMatchObject({ accountId: "acc-cash", accountExplicit: true, status: "resolved", placeholder: { status: "final" } });
  });
  it("409 unless pending with no matched line", async () => {
    const p = await seed({ payee: "P", total: 1000, status: "partial" });
    expect((await req("PATCH", `/api/intents/${p.id}`, { payee: "X" })).json).toMatchObject({ error: { code: "conflict" } });
    expect((await req("PATCH", `/api/intents/${p.id}`, { bogus: 1 })).status).toBe(400);
  });
});

describe("extend / cancel / keep", () => {
  it("extend: max(today, expires_on) + days", async () => {
    const stale = await seed({ payee: "S", total: 1000, expiresOn: addDays(TODAY, -5) });
    expect(IntentRes.parse((await req("POST", `/api/intents/${stale.id}/extend`, { days: 7 })).json).intent.expiresOn).toBe(addDays(TODAY, 7));
    const fresh = await seed({ payee: "F", total: 1000, expiresOn: addDays(TODAY, 3) });
    expect(IntentRes.parse((await req("POST", `/api/intents/${fresh.id}/extend`, { days: 14 })).json).intent.expiresOn).toBe(addDays(TODAY, 17));
    expect((await req("POST", `/api/intents/${fresh.id}/extend`, { days: 0 })).status).toBe(400);
    const done = await seed({ payee: "D", total: 1000, status: "resolved" });
    expect((await req("POST", `/api/intents/${done.id}/extend`, { days: 7 })).status).toBe(409);
  });

  it("cancel deletes an untouched placeholder", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    const i = IntentRes.parse((await req("DELETE", `/api/intents/${created.id}`)).json).intent;
    expect(i).toMatchObject({ status: "cancelled", placeholder: { status: "deleted" } });
    expect(fake.callsOf("deleteTransaction").map((c) => c.args[1])).toEqual([created.placeholder.txnId]);
    expect((await req("DELETE", `/api/intents/${created.id}`)).status).toBe(409);
  });

  it("cancel when YNAB merged an import into the placeholder: cancelled, txn untouched, refusal audited, no review", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    fake.txns.get(created.placeholder.txnId!)!.importId = "YNAB:x";
    const i = IntentRes.parse((await req("DELETE", `/api/intents/${created.id}`)).json).intent;
    expect(i.status).toBe("cancelled");
    expect(fake.callsOf("deleteTransaction")).toHaveLength(0);
    const acts = (await db().select().from(auditLog).where(eq(auditLog.intentId, created.id)).all()).map((a) => a.action);
    expect(acts).toContain("placeholder_delete_refused");
    expect(await db().select().from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.status, "open"))).all()).toHaveLength(0);
  });

  it("stale Delete with a merged placeholder opens a ynab_matched_other review", async () => {
    const created = CreateIntentsRes.parse((await create(draft({ date: addDays(TODAY, -40) }))).json).intents[0]!;
    fake.txns.get(created.placeholder.txnId!)!.cleared = "cleared";
    await req("DELETE", `/api/intents/${created.id}`);
    expect(await db().select().from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.status, "open"))).all())
      .toEqual([expect.objectContaining({ kind: "ynab_matched_other", intentId: created.id })]);
    expect((await row(created.id)).status).toBe("cancelled");
  });

  it("cancel dismisses the intent's open review and releases the other intents", async () => {
    const a = await seed({ payee: "A", total: 1000, status: "review" });
    const b = await seed({ payee: "B", total: 1000, status: "review" });
    const opt = (intentId: string, id: string) => ({ id, label: id, intentId, transactionId: "c", lineIds: [], allocation: [], score: 1 });
    await db().insert(reviews).values({ id: uid("r"), userId, intentId: a.id, ynabTxnId: null, kind: "ambiguous_match",
      options: JSON.stringify([opt(a.id, "o1"), opt(b.id, "o2")]), summary: "s", status: "open", createdAt: 1 });
    await req("DELETE", `/api/intents/${a.id}`);
    expect((await row(b.id)).status).toBe("pending");
  });

  it("keep as final strips ≈ from the memo, resolves, never touched again", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    const i = IntentRes.parse((await req("POST", `/api/intents/${created.id}/keep`)).json).intent;
    expect(i).toMatchObject({ status: "resolved", placeholder: { status: "final" } });
    // The final record carries the un-nudged total (199.99 placeholder → 200.00) and the line's category.
    expect(fake.callsOf("updateTransactions")[0]?.args[1]).toEqual([{
      id: created.placeholder.txnId, memo: `groceries [aib:${created.shortRef}]`, amount: -200000, categoryId: "cat-groceries",
    }]);
    const acts = (await db().select().from(auditLog).where(eq(auditLog.intentId, created.id)).all()).map((a) => a.action);
    expect(acts).toContain("intent_kept_final");
    expect((await req("POST", `/api/intents/${created.id}/keep`)).status).toBe(409);
  });

  it("keep as final with several categories turns the placeholder into a split final entry (review fix)", async () => {
    const created = CreateIntentsRes.parse((await create(draft({
      totalAmount: 50000, lines: [
        { description: "produce", categoryId: "cat-groceries", amount: 30000, approximate: true, confidence: null },
        { description: "flowers", categoryId: "cat-home", amount: 20000, approximate: true, confidence: null },
      ],
    }))).json).intents[0]!;
    expect(fake.txns.get(created.placeholder.txnId!)!.amount).toBe(-49990); // nudged placeholder
    await req("POST", `/api/intents/${created.id}/keep`);
    const [u] = fake.callsOf("updateTransactions")[0]?.args[1] as Record<string, unknown>[];
    expect(u).toMatchObject({ amount: -50000, categoryId: null, subtransactions: [
      { amount: -30000, categoryId: "cat-groceries", memo: "produce" }, { amount: -20000, categoryId: "cat-home", memo: "flowers" },
    ] });
    expect((await row(created.id)).placeholderAmount).toBe(50000);
  });

  it("keep refuses a placeholder YNAB merged with an import (live guard) and writes nothing", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    Object.assign(fake.txns.get(created.placeholder.txnId!)!, { importId: "YNAB:x", cleared: "cleared" });
    expect((await req("POST", `/api/intents/${created.id}/keep`)).status).toBe(409);
    expect(fake.callsOf("updateTransactions")).toHaveLength(0);
    expect((await row(created.id)).status).toBe("review");
  });

  it("per-intent routes act on the intent's own plan after the user switched plans (review fix)", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    m.settings = { planId: "plan-2" };
    const i = IntentRes.parse((await req("DELETE", `/api/intents/${created.id}`)).json).intent;
    expect(i).toMatchObject({ status: "cancelled", placeholder: { status: "deleted" } });
    expect(fake.callsOf("getTransaction").map((c) => c.args[0])).toEqual(["plan-1"]);
    expect(fake.callsOf("deleteTransaction").map((c) => c.args)).toEqual([["plan-1", created.placeholder.txnId]]);
  });

  it("PATCH keeps memo text the user added to the placeholder in YNAB", async () => {
    const created = CreateIntentsRes.parse((await create(draft())).json).intents[0]!;
    const p = fake.txns.get(created.placeholder.txnId!)!;
    p.memo = `note from me | ${p.memo}`;
    await req("PATCH", `/api/intents/${created.id}`, { totalAmount: 210000 });
    const [u] = fake.callsOf("updateTransactions")[0]?.args[1] as Record<string, unknown>[];
    expect(u).toMatchObject({ amount: -209990 });
    expect(u).not.toHaveProperty("memo");
  });

  it("keep needs a created placeholder", async () => {
    const p = await seed({ payee: "P", total: 1000 });
    expect((await req("POST", `/api/intents/${p.id}/keep`)).json).toMatchObject({ error: { code: "conflict" } });
  });
});

describe("manual linking", () => {
  it("candidates: loose filter minus excluded, sorted by score, as TxnView", async () => {
    const i = await seed({ payee: "Costco", total: 200000, date: YESTERDAY });
    const other = await seed({ payee: "Other", total: 1000, placeholderTxnId: "ph-other", placeholderStatus: "created" });
    void other;
    const good = mkTxn({ id: uid("good"), date: TODAY, amount: -199000, importPayeeName: "COSTCO WHSE" });
    const payeeOnly = mkTxn({ id: uid("payee"), date: TODAY, amount: -20000, importPayeeName: "COSTCO GAS" });
    const amountOnly = mkTxn({ id: uid("amt"), date: TODAY, amount: -210000, importPayeeName: "WALGREENS" });
    const neither = mkTxn({ id: uid("no"), date: TODAY, amount: -5000, importPayeeName: "WALGREENS" });
    const tooOld = mkTxn({ id: uid("old"), date: addDays(TODAY, -60), amount: -199000, importPayeeName: "COSTCO WHSE" });
    const placeholder = mkTxn({ id: "ph-other", date: TODAY, amount: -199000, importPayeeName: "COSTCO WHSE" });
    await cacheTxns(userId, [good, payeeOnly, amountOnly, neither, tooOld, placeholder]);
    const res = CandidatesRes.parse((await req("GET", `/api/intents/${i.id}/candidates`)).json);
    expect(res.transactions.map((t) => t.id)).toEqual([good.id, amountOnly.id, payeeOnly.id]);
    expect(res.transactions[0]).toMatchObject({ accountName: "Visa", isImported: true, importPayeeName: "COSTCO WHSE" });
  });

  it("link applies a manual match; an excluded txn is 409", async () => {
    const i = await seed({ payee: "Costco", total: 200000, date: YESTERDAY });
    const t = mkTxn({ id: uid("t"), date: TODAY, amount: -150000, importPayeeName: "SOMETHING" });
    fake.seed(t);
    await cacheTxns(userId, [t]);
    const r = IntentRes.parse((await req("POST", `/api/intents/${i.id}/link`, { transactionId: t.id, lineIds: null })).json).intent;
    expect(r).toMatchObject({ status: "resolved", matchedTransactionIds: [t.id] });
    expect((await db().select().from(matches).where(eq(matches.intentId, i.id)).get())).toMatchObject({ kind: "manual", state: "applied" });
    const j = await seed({ payee: "Costco", total: 200000 });
    expect((await req("POST", `/api/intents/${j.id}/link`, { transactionId: t.id, lineIds: null })).json).toMatchObject({ error: { code: "conflict" } });
  });

  it("link a subset of lines → partial; wrong direction or unknown lines → 400; unknown txn → 404", async () => {
    const i = await seed({ payee: "Target", total: 50000, lines: [
      { id: uid("l"), description: "lamp", categoryId: "cat-home", amount: 30000 }, { id: uid("l"), description: "lego", categoryId: "cat-kids", amount: 20000 },
    ] });
    const t = mkTxn({ id: uid("t"), date: TODAY, amount: -31000 });
    const refund = mkTxn({ id: uid("r"), date: TODAY, amount: 31000 });
    fake.seed(t, refund);
    await cacheTxns(userId, [t, refund]);
    expect((await req("POST", `/api/intents/${i.id}/link`, { transactionId: refund.id, lineIds: null })).status).toBe(400);
    expect((await req("POST", `/api/intents/${i.id}/link`, { transactionId: t.id, lineIds: ["nope"] })).status).toBe(400);
    expect((await req("POST", `/api/intents/${i.id}/link`, { transactionId: "missing", lineIds: null })).status).toBe(404);
    const r = IntentRes.parse((await req("POST", `/api/intents/${i.id}/link`, { transactionId: t.id, lineIds: [i.lineIds[0]] })).json).intent;
    expect(r.status).toBe("partial");
    expect(r.lines.map((l) => l.status)).toEqual(["matched", "open"]);
    const lines = await db().select().from(intentLines).where(eq(intentLines.intentId, i.id)).all();
    expect(lines.find((l) => l.status === "matched")?.matchedTxnId).toBe(t.id);
  });
});

// WP5 /api/reviews* and /api/activity on a test app (stub session), real D1, FakeYnab.
// WP2 getSettings and WP3 createYnabClient are mocked.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityRes, ReviewsRes } from "../../src/shared/api";
import type { ReviewOption } from "../../src/shared/schemas";
import { auditLog, intents, matches, reviews } from "../../src/worker/db/schema";
import type { AppEnv } from "../../src/worker/env";
import { FakeYnab, cacheTxns, db, mkTxn, seedIntent, seedUser, uid } from "./wp5-helpers";

const m = vi.hoisted(() => ({ fake: null as unknown, userId: "" }));
vi.mock("../../src/worker/auth/settings", async () => {
  const { DEFAULT_SETTINGS } = await import("../../src/shared/schemas");
  return { getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, planId: "plan-1", timezone: "UTC" })), updateSettings: vi.fn() };
});
vi.mock("../../src/worker/ynab/client", () => ({ createYnabClient: vi.fn(async () => m.fake), createYnabClientForToken: vi.fn() }));

let app: Hono<AppEnv>;
beforeAll(async () => {
  vi.resetModules();
  const H = await import("hono");
  const E = await import("../../src/worker/lib/errors");
  const { reviewRoutes } = await import("../../src/worker/routes/reviews");
  const { activityRoutes } = await import("../../src/worker/routes/activity");
  const { getDb } = await import("../../src/worker/db/client");
  app = new H.Hono<AppEnv>();
  app.onError(E.errorHandler);
  app.use("*", async (c, next) => {
    c.set("db", getDb(c.env));
    c.set("userId", m.userId);
    await next();
  });
  app.route("/api", reviewRoutes);
  app.route("/api", activityRoutes);
});

let userId: string;
let fake: FakeYnab;
beforeEach(async () => {
  userId = uid("user");
  m.userId = userId;
  fake = new FakeYnab();
  m.fake = fake;
  await seedUser(userId);
});

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {} };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(`https://app.test${path}`, init, env);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const status = async (id: string) => (await db().select({ s: intents.status }).from(intents).where(eq(intents.id, id)).get())?.s;

/** Two Amazon intents in a cross-intent review over one cached charge. */
async function crossReview() {
  const a = await seedIntent(userId, { payee: "Amazon", merchantKind: "amazon", total: 40000, status: "review", lines: [
    { description: "case", categoryId: "cat-home", amount: 30000 }, { description: "cable", categoryId: "cat-kids", amount: 10000 },
  ] });
  const b = await seedIntent(userId, { payee: "Amazon", merchantKind: "amazon", total: 40000, status: "review", lines: [
    { description: "book", categoryId: "cat-books", amount: 25000 }, { description: "toy", categoryId: "cat-toys", amount: 15000 },
  ] });
  const c = mkTxn({ id: uid("c"), amount: -42400, importPayeeName: "AMZN Mktp US*2K4L" });
  fake.seed(c);
  await cacheTxns(userId, [c]);
  const opt = (id: string, intentId: string, lineIds: string[], cats: [string, number][]): ReviewOption => ({
    id, label: id, intentId, transactionId: c.id, lineIds, score: 1,
    allocation: cats.map(([categoryId, amount]) => ({ categoryId, amount, memo: null })),
  });
  const reviewId = uid("rev");
  await db().insert(reviews).values({
    id: reviewId, userId, intentId: null, ynabTxnId: c.id, kind: "amazon_split", summary: "Which order?", status: "open", createdAt: Date.now(),
    options: JSON.stringify([
      opt("o1", a.id, a.lineIds, [["cat-home", -31800], ["cat-kids", -10600]]),
      opt("o2", b.id, b.lineIds, [["cat-books", -26500], ["cat-toys", -15900]]),
    ]),
  });
  return { a, b, c, reviewId };
}

describe("GET /api/reviews", () => {
  it("returns open reviews with every referenced transaction and intent", async () => {
    const { a, b, c, reviewId } = await crossReview();
    await db().insert(reviews).values({ id: uid("closed"), userId, intentId: a.id, kind: "too_complex", options: "[]", summary: "x", status: "dismissed", createdAt: 1 });
    const res = ReviewsRes.parse((await req("GET", "/api/reviews")).json);
    expect(res.reviews).toHaveLength(1);
    const r = res.reviews[0]!;
    expect(r).toMatchObject({ id: reviewId, kind: "amazon_split", intentId: null, transactionId: c.id, summary: "Which order?" });
    expect(r.transactions.map((t) => t.id)).toEqual([c.id]);
    expect(r.intents.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.options).toHaveLength(2);
  });
  it("empty list", async () => {
    expect(ReviewsRes.parse((await req("GET", "/api/reviews")).json).reviews).toEqual([]);
  });
});

describe("POST /api/reviews/:id/resolve", () => {
  it("applies the chosen option (kind 'review') and releases the other intent", async () => {
    const { a, b, c, reviewId } = await crossReview();
    const r = await req("POST", `/api/reviews/${reviewId}/resolve`, { optionId: "o2" });
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(await status(b.id)).toBe("resolved");
    expect(await status(a.id)).toBe("pending");
    expect((await db().select().from(matches).where(eq(matches.intentId, b.id)).get())).toMatchObject({ kind: "review", ynabTxnId: c.id, state: "applied" });
    const u = (fake.callsOf("updateTransactions")[0]?.args[1] as Record<string, unknown>[])[0];
    expect(u).toMatchObject({ id: c.id, approved: true, categoryId: null, subtransactions: [
      { amount: -26500, categoryId: "cat-books", memo: null }, { amount: -15900, categoryId: "cat-toys", memo: null },
    ] });
    expect((await db().select().from(reviews).where(eq(reviews.id, reviewId)).get())?.status).toBe("resolved");
    const acts = (await db().select().from(auditLog).where(eq(auditLog.userId, userId)).all()).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["txn_split", "txn_approved", "intent_resolved", "review_resolved"]));
    // closed now
    expect((await req("POST", `/api/reviews/${reviewId}/resolve`, { optionId: "o1" })).json).toMatchObject({ error: { code: "conflict" } });
  });

  it("dismiss returns every referenced intent to pending/partial", async () => {
    const { a, b, reviewId } = await crossReview();
    await db().update(intents).set({ status: "review" }).where(eq(intents.id, a.id));
    expect((await req("POST", `/api/reviews/${reviewId}/resolve`, { dismiss: true })).status).toBe(200);
    expect(await status(a.id)).toBe("pending");
    expect(await status(b.id)).toBe("pending");
    expect(fake.calls).toHaveLength(0);
    expect((await db().select().from(reviews).where(eq(reviews.id, reviewId)).get())?.status).toBe("dismissed");
  });

  it("dismissing ynab_matched_other leaves the txn alone and marks the placeholder missing", async () => {
    const i = await seedIntent(userId, { payee: "Costco", total: 15000, status: "review", placeholderTxnId: "ph-1", placeholderStatus: "created", placeholderAmount: 15000 });
    const rid = uid("r");
    await db().insert(reviews).values({ id: rid, userId, intentId: i.id, ynabTxnId: "ph-1", kind: "ynab_matched_other", options: "[]", summary: "s", status: "open", createdAt: 1 });
    await req("POST", `/api/reviews/${rid}/resolve`, { dismiss: true });
    expect(await db().select({ s: intents.status, p: intents.placeholderStatus }).from(intents).where(eq(intents.id, i.id)).get()).toEqual({ s: "pending", p: "missing" });
  });

  it("confirming a ynab_matched_other option keeps the merged placeholder (auto_matched)", async () => {
    const i = await seedIntent(userId, { payee: "Costco", total: 15000, approximate: false, status: "review", placeholderTxnId: "ph-2", placeholderStatus: "created", placeholderAmount: 15000 });
    const p = mkTxn({ id: "ph-2", amount: -15000, importPayeeName: "NETFLIX", categoryId: "cat-groceries", approved: true, memo: "x" });
    fake.seed(p);
    await cacheTxns(userId, [p]);
    const rid = uid("r");
    await db().insert(reviews).values({ id: rid, userId, intentId: i.id, ynabTxnId: "ph-2", kind: "ynab_matched_other", summary: "s", status: "open", createdAt: 1,
      options: JSON.stringify([{ id: "o1", label: "l", intentId: i.id, transactionId: "ph-2", lineIds: i.lineIds, allocation: [{ categoryId: "cat-groceries", amount: -15000, memo: null }], score: 0.1 }]) });
    expect((await req("POST", `/api/reviews/${rid}/resolve`, { optionId: "o1" })).status).toBe(200);
    expect(await db().select({ s: intents.status, p: intents.placeholderStatus }).from(intents).where(eq(intents.id, i.id)).get()).toEqual({ s: "resolved", p: "auto_matched" });
    expect(fake.callsOf("deleteTransaction")).toHaveLength(0);
  });

  it("an option whose lines were matched meanwhile → 409, review stays open", async () => {
    const { a, reviewId } = await crossReview();
    const { intentLines } = await import("../../src/worker/db/schema");
    await db().update(intentLines).set({ status: "matched" }).where(eq(intentLines.intentId, a.id));
    expect((await req("POST", `/api/reviews/${reviewId}/resolve`, { optionId: "o1" })).json).toMatchObject({ error: { code: "conflict" } });
    expect((await db().select().from(reviews).where(eq(reviews.id, reviewId)).get())?.status).toBe("open");
  });

  it("unknown option → 400; unknown or foreign review → 404; bad body → 400", async () => {
    const { reviewId } = await crossReview();
    expect((await req("POST", `/api/reviews/${reviewId}/resolve`, { optionId: "zz" })).status).toBe(400);
    expect((await req("POST", `/api/reviews/${reviewId}/resolve`, { nope: 1 })).status).toBe(400);
    expect((await req("POST", `/api/reviews/missing/resolve`, { dismiss: true })).status).toBe(404);
    m.userId = uid("other");
    expect((await req("POST", `/api/reviews/${reviewId}/resolve`, { dismiss: true })).status).toBe(404);
  });
});

describe("GET /api/activity", () => {
  it("pages of 50, newest first, cursor by timestamp, own rows only", async () => {
    const rows = Array.from({ length: 60 }, (_, k) => ({
      id: uid("a"), userId, at: 1_000_000 + k, actor: "app" as const, action: "intent_created" as const, summary: `#${k}`,
      intentId: null, ynabTxnId: k === 59 ? "t-1" : null,
    }));
    for (let k = 0; k < rows.length; k += 10) await db().insert(auditLog).values(rows.slice(k, k + 10));
    const other = uid("other");
    await seedUser(other);
    await db().insert(auditLog).values({ id: uid("a"), userId: other, at: 2_000_000, actor: "app", action: "login", summary: "theirs" });

    const p1 = ActivityRes.parse((await req("GET", "/api/activity")).json);
    expect(p1.entries).toHaveLength(50);
    expect(p1.entries[0]).toMatchObject({ summary: "#59", transactionId: "t-1", action: "intent_created", actor: "app" });
    expect(p1.nextCursor).toBe(1_000_010);
    const p2 = ActivityRes.parse((await req("GET", `/api/activity?before=${p1.nextCursor}`)).json);
    expect(p2.entries.map((e) => e.summary)).toEqual(Array.from({ length: 10 }, (_, k) => `#${9 - k}`));
    expect(p2.nextCursor).toBeNull();
  });

  it("never splits a millisecond across pages", async () => {
    const rows = Array.from({ length: 55 }, (_, k) => ({
      id: `${uid("a")}-${String(k).padStart(2, "0")}`, userId, at: k < 45 ? 5_000 - k : 100, actor: "user" as const, action: "logout" as const, summary: `${k}`,
    }));
    for (let k = 0; k < rows.length; k += 10) await db().insert(auditLog).values(rows.slice(k, k + 10));
    await db().insert(auditLog).values({ id: uid("last"), userId, at: 50, actor: "user", action: "logout", summary: "oldest" });
    const p1 = ActivityRes.parse((await req("GET", "/api/activity")).json);
    expect(p1.entries).toHaveLength(55); // 45 + all 10 entries at t=100
    expect(p1.nextCursor).toBe(100);
    const p2 = ActivityRes.parse((await req("GET", "/api/activity?before=100")).json);
    expect(p2.entries.map((e) => e.summary)).toEqual(["oldest"]);
  });

  it("rejects a bad cursor", async () => {
    expect((await req("GET", "/api/activity?before=abc")).status).toBe(400);
  });
});

describe("dismissed reviews are filtered from the open list", () => {
  it("only open", async () => {
    const i = await seedIntent(userId, { payee: "X", total: 1000 });
    await db().insert(reviews).values({ id: uid("r"), userId, intentId: i.id, kind: "too_complex", options: "[]", summary: "s", status: "resolved", createdAt: 1 });
    expect(await db().select().from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.status, "open"))).all()).toHaveLength(0);
    expect(ReviewsRes.parse((await req("GET", "/api/reviews")).json).reviews).toEqual([]);
  });
});

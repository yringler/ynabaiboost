// WP5 engine against real D1 and an in-memory YNAB (FakeYnab): placeholders, final entries, applyMatch,
// the delete guard, reconcileUser end to end (§13), crash replay, YNAB auto-match, reviews, exclusions, counts, prune.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../src/shared/schemas";
import { auditLog, intentLines, intents, matches, reviews, sessions, users, ynabTransactions } from "../../src/worker/db/schema";
import { PLAN, FakeYnab, cacheTxns, db, mkTxn, seedIntent, seedUser, settingsFor, uid } from "./wp5-helpers";

const m = vi.hoisted(() => ({ settings: new Map<string, Partial<Settings>>() }));
vi.mock("../../src/worker/auth/settings", async () => {
  const { DEFAULT_SETTINGS } = await import("../../src/shared/schemas");
  return {
    getSettings: vi.fn(async (_db: unknown, id: string) => ({ ...DEFAULT_SETTINGS, planId: "plan-1", timezone: "UTC", ...(m.settings.get(id) ?? {}) })),
    updateSettings: vi.fn(),
  };
});

let R: typeof import("../../src/worker/engine/reconcile");
let A: typeof import("../../src/worker/engine/apply");
let P: typeof import("../../src/worker/engine/placeholders");
let L: typeof import("../../src/worker/engine/load");
let RV: typeof import("../../src/worker/engine/reviews");
let T: typeof import("../../src/worker/domain/tolerance");
let E: typeof import("../../src/worker/lib/errors");
beforeAll(async () => {
  vi.resetModules();
  R = await import("../../src/worker/engine/reconcile");
  A = await import("../../src/worker/engine/apply");
  P = await import("../../src/worker/engine/placeholders");
  L = await import("../../src/worker/engine/load");
  RV = await import("../../src/worker/engine/reviews");
  T = await import("../../src/worker/domain/tolerance");
  E = await import("../../src/worker/lib/errors");
});

const TODAY = "2026-11-16";
const DELTA = { initial: false, changedTxnIds: [], deletedTxnIds: [], serverKnowledge: 2 };
let userId: string;
let fake: FakeYnab;
const ctx = (over: Partial<Settings> = {}, actor: "user" | "cron" = "cron") => ({
  env, db: db(), client: fake, userId, planId: PLAN, settings: settingsFor(over), currency: { isoCode: "USD", decimalDigits: 2 },
  today: TODAY, actor,
});
const seed = (s: Parameters<typeof seedIntent>[1]) => seedIntent(userId, s, (a, x) => T.computeTolerance(a, x));
const intentRow = async (id: string) => (await db().select().from(intents).where(eq(intents.id, id)).get())!;
const linesOf = (id: string) => db().select().from(intentLines).where(eq(intentLines.intentId, id)).orderBy(intentLines.idx).all();
const auditActions = async (intentId: string) =>
  (await db().select().from(auditLog).where(and(eq(auditLog.userId, userId), eq(auditLog.intentId, intentId))).orderBy(auditLog.at).all()).map((a) => a.action);
const openReviewsOf = () => db().select().from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.status, "open"))).all();

beforeEach(async () => {
  userId = uid("user");
  fake = new FakeYnab();
  await seedUser(userId);
});

/** Creates the placeholder of a fresh intent through the engine and returns ids. */
async function withPlaceholder(s: Parameters<typeof seedIntent>[1], over: Partial<Settings> = {}) {
  const i = await seed(s);
  const r = await P.createPlaceholder(ctx(over, "user"), i.id);
  expect(r).toEqual({ ok: true, kind: "placeholder", warning: null });
  const row = await intentRow(i.id);
  return { ...i, phId: row.placeholderTxnId! };
}

describe("createPlaceholder (§10.7, D13)", () => {
  it("creates a nudged, tagged, approved placeholder on a linked account", async () => {
    const i = await seed({ payee: "Costco", total: 200000, memo: null, lines: [
      { description: "groceries", categoryId: "cat-groceries", amount: 150000 }, { description: "socks", categoryId: "cat-household", amount: 50000 },
    ] });
    expect(await P.createPlaceholder(ctx({}, "user"), i.id)).toEqual({ ok: true, kind: "placeholder", warning: null });
    const [call] = fake.callsOf("createTransaction");
    expect(call?.args[1]).toEqual({
      accountId: "acc-card", date: "2026-11-10", amount: -199990, payeeId: null, payeeName: "Costco",
      categoryId: "cat-groceries", memo: `≈ groceries, socks [aib:${i.shortRef}]`, approved: true, flagColor: "purple",
    });
    const row = await intentRow(i.id);
    expect(row).toMatchObject({ placeholderStatus: "created", placeholderAmount: 199990, status: "pending" });
    const cached = await db().select().from(ynabTransactions).where(and(eq(ynabTransactions.userId, userId), eq(ynabTransactions.id, row.placeholderTxnId!))).get();
    expect(cached?.amount).toBe(-199990);
    expect(await auditActions(i.id)).toEqual(["placeholder_created"]);
  });

  it("an exact amount is not nudged; the date is clamped to today; the intent memo wins", async () => {
    const i = await seed({ payee: "Shell", total: 47230, approximate: false, date: "2026-11-20", memo: "road trip" });
    await P.createPlaceholder(ctx({ flagColor: null }, "user"), i.id);
    expect(fake.callsOf("createTransaction")[0]?.args[1]).toMatchObject({
      amount: -47230, date: TODAY, memo: `road trip [aib:${i.shortRef}]`, flagColor: null,
    });
  });

  it("an unlinked (cash) account gets a final entry: full amount, split by category, intent resolved", async () => {
    const i = await seed({ payee: "Farmers market", total: 30000, accountId: "acc-cash", lines: [
      { description: "veg", categoryId: "cat-groceries", amount: 20000 }, { description: "flowers", categoryId: "cat-home", amount: 10000 },
    ] });
    expect(await P.createPlaceholder(ctx({}, "user"), i.id)).toEqual({ ok: true, kind: "final", warning: null });
    const n = fake.callsOf("createTransaction")[0]?.args[1] as Record<string, unknown>;
    expect(n).toMatchObject({ accountId: "acc-cash", amount: -30000, categoryId: null, approved: true, memo: `veg, flowers [aib:${i.shortRef}]` });
    expect(n.subtransactions).toEqual([
      { amount: -20000, categoryId: "cat-groceries", memo: "veg" }, { amount: -10000, categoryId: "cat-home", memo: "flowers" },
    ]);
    expect(await intentRow(i.id)).toMatchObject({ placeholderStatus: "final", status: "resolved", placeholderAmount: 30000 });
    expect((await linesOf(i.id)).every((l) => l.status === "matched")).toBe(true);
    expect(await auditActions(i.id)).toEqual(["final_entry_created"]);
    // a final entry is never deleted
    expect(await P.safeDeletePlaceholder(ctx(), i.id, "cancelled")).toBe("gone");
    expect(fake.callsOf("deleteTransaction")).toHaveLength(0);
  });

  it("no account anywhere → skipped with a warning", async () => {
    const i = await seed({ payee: "Nowhere", total: 10000, accountId: null });
    const r = await P.createPlaceholder(ctx({ defaultAccountId: null }, "user"), i.id);
    expect(r).toMatchObject({ ok: false, kind: "none" });
    expect(r.warning).toMatch(/no account/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("falls back to the last account used at a similar payee, then the default account", async () => {
    await cacheTxns(userId, [mkTxn({ id: uid("t"), payeeName: "Trader Joe's", accountId: "acc-cash", date: "2026-11-01" })]);
    const i = await seed({ payee: "Trader Joes", total: 10000, accountId: null });
    expect((await P.createPlaceholder(ctx({}, "user"), i.id)).kind).toBe("final"); // acc-cash is unlinked
    const j = await seed({ payee: "Unknown shop", total: 10000, accountId: null });
    await P.createPlaceholder(ctx({ defaultAccountId: "acc-card" }, "user"), j.id);
    expect(fake.callsOf("createTransaction")[1]?.args[1]).toMatchObject({ accountId: "acc-card" });
  });

  it("retries once with today's UTC date when YNAB rejects a future date (spike S3)", async () => {
    const i = await seed({ payee: "Late night", total: 10000, date: "2099-01-02" });
    fake.failNext("createTransaction", () => new E.AppError("ynab_error", "YNAB error 400", { status: 400, detail: "date must not be in the future" }));
    const r = await P.createPlaceholder({ ...ctx({}, "user"), today: "2099-01-01" }, i.id);
    expect(r.ok).toBe(true);
    const calls = fake.callsOf("createTransaction");
    expect(calls).toHaveLength(2);
    expect((calls[1]?.args[1] as { date: string }).date <= "2099-01-01").toBe(true);
  });

  it("a YNAB failure marks the placeholder failed and returns a warning", async () => {
    const i = await seed({ payee: "Costco", total: 10000 });
    fake.failNext("createTransaction", () => new E.AppError("ynab_rate_limited", "slow down"));
    const r = await P.createPlaceholder(ctx({}, "user"), i.id);
    expect(r).toMatchObject({ ok: false, kind: "placeholder" });
    expect(r.warning).toContain("slow down");
    expect((await intentRow(i.id)).placeholderStatus).toBe("failed");
  });
});

describe("reconcile end to end (§13)", () => {
  it("intent → placeholder → import → PATCH → guarded DELETE → resolved, with audit rows", async () => {
    const i = await withPlaceholder({ payee: "Costco", total: 200000, lines: [{ description: "groceries", categoryId: "cat-groceries", amount: 200000 }] });
    const imp = mkTxn({ id: uid("imp"), date: "2026-11-11", amount: -173500, importPayeeName: "COSTCO WHSE #0123", payeeName: "Costco", memo: "card 1234" });
    fake.seed(imp);
    await cacheTxns(userId, [imp]);

    const s = await R.reconcileUser(ctx(), DELTA);
    expect(s).toMatchObject({ matched: 1, reviewsCreated: 0, errors: [] });

    const [patch] = fake.callsOf("updateTransactions");
    expect(patch?.args[1]).toEqual([{
      id: imp.id, memo: `card 1234 | groceries [aib:${i.shortRef}]`, flagColor: "purple", approved: true, categoryId: "cat-groceries",
    }]);
    // guard: a live GET of the placeholder, then the DELETE
    expect(fake.callsOf("getTransaction").map((c) => c.args[1])).toEqual([i.phId]);
    expect(fake.callsOf("deleteTransaction").map((c) => c.args[1])).toEqual([i.phId]);
    const order = fake.calls.map((c) => c.method);
    expect(order.indexOf("updateTransactions")).toBeLessThan(order.indexOf("deleteTransaction"));

    expect(await intentRow(i.id)).toMatchObject({ status: "resolved", placeholderStatus: "deleted" });
    const ms = await db().select().from(matches).where(eq(matches.intentId, i.id)).all();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ ynabTxnId: imp.id, state: "applied", kind: "single" });
    expect((await linesOf(i.id))[0]).toMatchObject({ status: "matched", matchedTxnId: imp.id });
    expect(await auditActions(i.id)).toEqual(expect.arrayContaining(["placeholder_created", "txn_categorized", "txn_approved", "placeholder_deleted", "intent_resolved"]));
    const cat = await db().select().from(auditLog).where(and(eq(auditLog.intentId, i.id), eq(auditLog.action, "txn_categorized"))).get();
    expect(JSON.parse(cat!.beforeJson!)).toEqual({ categoryId: null, approved: false, memo: "card 1234", flagColor: null, isSplit: false });
    expect(JSON.parse(cat!.afterJson!)).toMatchObject({ categoryId: "cat-groceries", approved: true, flagColor: "purple" });
    const cachedImp = await db().select().from(ynabTransactions).where(and(eq(ynabTransactions.userId, userId), eq(ynabTransactions.id, imp.id))).get();
    expect(cachedImp).toMatchObject({ categoryId: "cat-groceries", approved: true });

    // idempotent: a second run does nothing
    fake.calls = [];
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ matched: 0, errors: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("autoApproveMatches=false leaves the import unapproved", async () => {
    const i = await seed({ payee: "Costco", total: 200000 });
    const imp = mkTxn({ id: uid("imp"), amount: -190000, importPayeeName: "COSTCO WHSE" });
    fake.seed(imp);
    await cacheTxns(userId, [imp]);
    await R.reconcileUser(ctx({ autoApproveMatches: false }), DELTA);
    const u = (fake.callsOf("updateTransactions")[0]?.args[1] as Record<string, unknown>[])[0];
    expect(u).not.toHaveProperty("approved");
    expect((await intentRow(i.id)).status).toBe("resolved");
  });

  it("the guard refuses when the placeholder carries an import_id: no DELETE, review created, intent still resolves", async () => {
    const i = await withPlaceholder({ payee: "Costco", total: 200000 });
    fake.txns.get(i.phId)!.importId = "YNAB:merged";
    const imp = mkTxn({ id: uid("imp"), amount: -173500, importPayeeName: "COSTCO WHSE" });
    fake.seed(imp);
    await cacheTxns(userId, [imp]);
    await R.reconcileUser(ctx(), DELTA);
    expect(fake.callsOf("deleteTransaction")).toHaveLength(0);
    expect(await intentRow(i.id)).toMatchObject({ status: "resolved" });
    expect(await auditActions(i.id)).toContain("placeholder_delete_refused");
    const open = await openReviewsOf();
    expect(open).toEqual([expect.objectContaining({ intentId: i.id, ynabTxnId: i.phId, kind: "ynab_matched_other" })]);
  });

  it("crash replay: tag present, planned row stale → finalize without a second PATCH", async () => {
    const i = await withPlaceholder({ payee: "Costco", total: 200000 });
    const imp = mkTxn({ id: uid("imp"), amount: -173500, importPayeeName: "COSTCO WHSE", memo: `groceries [aib:${i.shortRef}]`, approved: true, categoryId: "cat-groceries" });
    fake.seed(imp);
    await cacheTxns(userId, [imp]);
    await db().insert(matches).values({
      id: uid("m"), userId, intentId: i.id, ynabTxnId: imp.id, kind: "single", lineIds: JSON.stringify(i.lineIds),
      allocation: JSON.stringify([{ categoryId: "cat-groceries", amount: -173500, memo: null }]), score: 0.9,
      state: "planned", error: null, createdAt: Date.now() - 11 * 60_000, appliedAt: null,
    });
    const s = await R.reconcileUser(ctx(), DELTA);
    expect(s).toMatchObject({ matched: 1, errors: [] });
    expect(fake.callsOf("updateTransactions")).toHaveLength(0);
    expect(fake.callsOf("deleteTransaction")).toHaveLength(1);
    const ms = await db().select().from(matches).where(eq(matches.intentId, i.id)).all();
    expect(ms.map((x) => x.state).sort()).toEqual(["applied", "failed"]);
    expect(await intentRow(i.id)).toMatchObject({ status: "resolved" });
  });

  it("a fresh planned row (< 10 min) keeps its txn excluded", async () => {
    const i = await seed({ payee: "Costco", total: 200000, shortRef: "ABCDEF" });
    const imp = mkTxn({ id: uid("imp"), amount: -173500, importPayeeName: "COSTCO WHSE", memo: "[aib:ABCDEF]" });
    await cacheTxns(userId, [imp]);
    await db().insert(matches).values({
      id: uid("m"), userId, intentId: i.id, ynabTxnId: imp.id, kind: "single", lineIds: "[]", allocation: "[]", score: null,
      state: "planned", error: null, createdAt: Date.now(), appliedAt: null,
    });
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ matched: 0 });
    expect((await intentRow(i.id)).status).toBe("pending");
  });

  it("YNAB auto-match merged in place → ynab_auto, no write needed, placeholder kept (auto_matched)", async () => {
    const i = await withPlaceholder({ payee: "Shell", total: 47230, approximate: false, lines: [{ description: "gas", categoryId: "cat-fuel", amount: 47230 }] });
    const p = fake.txns.get(i.phId)!;
    Object.assign(p, { importId: "YNAB:-47230:2026-11-10:1", importPayeeName: "SHELL OIL 57444", cleared: "cleared" });
    await cacheTxns(userId, [p]);
    fake.calls = [];
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ matched: 1, errors: [] });
    expect(fake.calls).toHaveLength(0); // approved, categorized, tagged, flagged already
    expect(await intentRow(i.id)).toMatchObject({ status: "resolved", placeholderStatus: "auto_matched" });
    expect((await db().select().from(matches).where(eq(matches.intentId, i.id)).get())).toMatchObject({ kind: "ynab_auto", state: "applied" });
  });

  it("YNAB auto-match of a multi-category intent → split written on the merged txn", async () => {
    const i = await withPlaceholder({ payee: "Target", total: 50000, approximate: false, lines: [
      { description: "lamp", categoryId: "cat-home", amount: 30000 }, { description: "lego", categoryId: "cat-kids", amount: 20000 },
    ] });
    const p = fake.txns.get(i.phId)!;
    Object.assign(p, { importId: "YNAB:x", importPayeeName: "TARGET T-1234", cleared: "cleared" });
    await cacheTxns(userId, [p]);
    fake.calls = [];
    await R.reconcileUser(ctx(), DELTA);
    const u = (fake.callsOf("updateTransactions")[0]?.args[1] as Record<string, unknown>[])[0];
    expect(u).toMatchObject({ id: i.phId, categoryId: null, subtransactions: [
      { amount: -30000, categoryId: "cat-home", memo: "lamp" }, { amount: -20000, categoryId: "cat-kids", memo: "lego" },
    ] });
    expect(await auditActions(i.id)).toContain("txn_split");
  });

  it("YNAB matched the placeholder with another payee → ynab_matched_other review, nothing written", async () => {
    const i = await withPlaceholder({ payee: "Costco", total: 15000, approximate: false });
    const p = fake.txns.get(i.phId)!;
    Object.assign(p, { importId: "YNAB:x", importPayeeName: "NETFLIX.COM", cleared: "cleared" });
    await cacheTxns(userId, [p]);
    fake.calls = [];
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ matched: 0, reviewsCreated: 1 });
    expect(fake.calls).toHaveLength(0);
    const [r] = await openReviewsOf();
    expect(r).toMatchObject({ kind: "ynab_matched_other", intentId: i.id, ynabTxnId: i.phId });
    expect(JSON.parse(r!.options)[0]).toMatchObject({ id: "o1", intentId: i.id, transactionId: i.phId, label: expect.stringContaining("15.00") });
    expect((await intentRow(i.id)).status).toBe("review");
  });

  it("placeholder deleted by the user → placeholder_status 'missing'", async () => {
    const i = await withPlaceholder({ payee: "Bakery", total: 12000 });
    const p = fake.txns.get(i.phId)!;
    await cacheTxns(userId, [{ ...p, deleted: true }]);
    await R.reconcileUser(ctx(), DELTA);
    expect(await intentRow(i.id)).toMatchObject({ placeholderStatus: "missing", status: "pending" });
  });

  it("ambiguous candidates → one review per intent with labelled options; a re-run updates it in place", async () => {
    const i = await seed({ payee: "Costco", total: 200000 });
    const a = mkTxn({ id: uid("a"), amount: -190000, importPayeeName: "COSTCO WHSE", date: "2026-11-11" });
    const b = mkTxn({ id: uid("b"), amount: -192000, importPayeeName: "COSTCO WHSE", date: "2026-11-11" });
    await cacheTxns(userId, [a, b]);
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ reviewsCreated: 1, matched: 0 });
    const [r] = await openReviewsOf();
    expect(r).toMatchObject({ kind: "ambiguous_match", intentId: i.id });
    const opts = JSON.parse(r!.options) as { label: string }[];
    expect(opts.map((o) => o.label)).toEqual(expect.arrayContaining(["COSTCO WHSE 192.00 on Nov 11", "COSTCO WHSE 190.00 on Nov 11"]));
    expect((await intentRow(i.id)).status).toBe("review");
    // excluded now (review txns) and the intent is in review: nothing new
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ reviewsCreated: 0 });
    expect(await openReviewsOf()).toHaveLength(1);
    expect((await L.excludedTxnIds(db(), userId, PLAN))).toEqual(new Set([a.id, b.id]));
  });

  it("a dismissed review is not re-opened with the same options", async () => {
    const i = await seed({ payee: "Costco", total: 200000 });
    await cacheTxns(userId, [
      mkTxn({ id: uid("a"), amount: -190000, importPayeeName: "COSTCO WHSE" }), mkTxn({ id: uid("b"), amount: -192000, importPayeeName: "COSTCO WHSE" }),
    ]);
    await R.reconcileUser(ctx(), DELTA);
    const [r] = await openReviewsOf();
    await RV.closeReview({ db: db(), userId, actor: "user" }, r!, "dismissed", null);
    expect((await intentRow(i.id)).status).toBe("pending");
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ reviewsCreated: 0 });
    expect(await openReviewsOf()).toHaveLength(0);
  });

  it("cross-intent Amazon review: both intents to 'review'; resolving one releases the other", async () => {
    const i1 = await seed({ payee: "Amazon", merchantKind: "amazon", total: 40000, approximate: false, date: "2026-11-05", lines: [
      { description: "case", categoryId: "cat-home", amount: 30000 }, { description: "cable", categoryId: "cat-kids", amount: 10000 },
    ] });
    const i2 = await seed({ payee: "Amazon", merchantKind: "amazon", total: 40000, approximate: false, date: "2026-11-06", lines: [
      { description: "book", categoryId: "cat-books", amount: 25000 }, { description: "toy", categoryId: "cat-toys", amount: 15000 },
    ] });
    const c = mkTxn({ id: uid("c"), amount: -42400, importPayeeName: "AMZN Mktp US*2K4L", date: "2026-11-08" });
    fake.seed(c);
    await cacheTxns(userId, [c]);
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ reviewsCreated: 1, matched: 0 });
    const [r] = await openReviewsOf();
    expect(r).toMatchObject({ intentId: null, ynabTxnId: c.id, kind: "amazon_split" });
    expect((await intentRow(i1.id)).status).toBe("review");
    expect((await intentRow(i2.id)).status).toBe("review");
    const opt = (JSON.parse(r!.options) as { intentId: string; label: string }[]).find((o) => o.intentId === i2.id)!;
    expect(opt.label).toContain("Amazon (2026-11-06): charge 42.40");

    await A.applyMatch(ctx({}, "user"), { ...(opt as never as { lineIds: string[]; allocation: never[] }), intentId: i2.id, txnId: c.id, score: 1, kind: "review" });
    await RV.closeReview({ db: db(), userId, actor: "user" }, r!, "resolved", i2.id);
    expect((await intentRow(i2.id)).status).toBe("resolved");
    expect((await intentRow(i1.id)).status).toBe("pending");
  });

  it("Amazon partial: resolving a subset leaves the intent partial and re-nudges the placeholder (scenario 10)", async () => {
    const i = await withPlaceholder({ payee: "Amazon", merchantKind: "amazon", total: 85000, approximate: true, date: "2026-11-05", lines: [
      { description: "case", categoryId: "cat-home", amount: 20000 }, { description: "book", categoryId: "cat-books", amount: 15000 },
      { description: "lamp", categoryId: "cat-lamp", amount: 50000 },
    ] });
    expect(fake.callsOf("createTransaction")[0]?.args[1]).toMatchObject({ amount: -84990 });
    const c = mkTxn({ id: uid("c"), amount: -37100, importPayeeName: "AMZN Mktp US*2K4L", date: "2026-11-07" });
    fake.seed(c);
    await cacheTxns(userId, [c]);
    expect(await R.reconcileUser(ctx(), DELTA)).toMatchObject({ reviewsCreated: 1 });
    const [r] = await openReviewsOf();
    const top = (JSON.parse(r!.options) as { lineIds: string[]; allocation: { amount: number }[]; label: string }[])[0]!;
    expect(top.label).toBe("Charge 37.10 on Nov 7 → case, book");
    fake.calls = [];
    await A.applyMatch(ctx({}, "user"), { intentId: i.id, txnId: c.id, lineIds: top.lineIds, allocation: top.allocation as never, score: 1, kind: "review" });
    expect(await intentRow(i.id)).toMatchObject({ status: "partial", placeholderAmount: 49990, placeholderStatus: "created" });
    const ups = fake.callsOf("updateTransactions").map((x) => (x.args[1] as Record<string, unknown>[])[0]);
    expect(ups[1]).toEqual({ id: i.phId, amount: -49990, categoryId: "cat-lamp" });
    expect(await auditActions(i.id)).toContain("placeholder_updated");
  });
});

describe("applyMatch (§10.9)", () => {
  it("rejects a second live match on the same txn with 409 conflict", async () => {
    const i = await seed({ payee: "Costco", total: 10000 });
    const j = await seed({ payee: "Costco", total: 10000 });
    const t = mkTxn({ id: uid("t"), amount: -10000 });
    fake.seed(t);
    await cacheTxns(userId, [t]);
    const alloc = [{ categoryId: "cat-groceries", amount: -10000, memo: null }];
    await A.applyMatch(ctx(), { intentId: i.id, txnId: t.id, lineIds: i.lineIds, allocation: alloc, score: null, kind: "manual" });
    await expect(A.applyMatch(ctx(), { intentId: j.id, txnId: t.id, lineIds: j.lineIds, allocation: alloc, score: null, kind: "manual" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("a split txn → split_conflict review, memo-only write, match failed", async () => {
    const i = await seed({ payee: "Target", total: 50000, lines: [
      { description: "lamp", categoryId: "cat-home", amount: 30000 }, { description: "lego", categoryId: "cat-kids", amount: 20000 },
    ] });
    const t = mkTxn({ id: uid("t"), amount: -50000, isSplit: true });
    fake.seed(t);
    await cacheTxns(userId, [t]);
    await A.applyMatch(ctx(), { intentId: i.id, txnId: t.id, lineIds: i.lineIds, score: null, kind: "manual", allocation: [
      { categoryId: "cat-home", amount: -30000, memo: "lamp" }, { categoryId: "cat-kids", amount: -20000, memo: "lego" },
    ] });
    expect(fake.callsOf("updateTransactions")[0]?.args[1]).toEqual([{ id: t.id, memo: `lamp, lego [aib:${i.shortRef}]` }]);
    expect((await db().select().from(matches).where(eq(matches.intentId, i.id)).get())).toMatchObject({ state: "failed", error: "split_conflict" });
    expect(await openReviewsOf()).toEqual([expect.objectContaining({ kind: "split_conflict", intentId: i.id })]);
    expect((await intentRow(i.id)).status).toBe("review");
  });

  it("a YNAB error marks the match failed and rethrows; the txn becomes available again", async () => {
    const i = await seed({ payee: "Costco", total: 10000 });
    const t = mkTxn({ id: uid("t"), amount: -10000 });
    fake.seed(t);
    await cacheTxns(userId, [t]);
    fake.failNext("updateTransactions", () => new E.AppError("ynab_error", "boom"));
    await expect(A.applyMatch(ctx(), { intentId: i.id, txnId: t.id, lineIds: i.lineIds, allocation: [{ categoryId: "cat-groceries", amount: -10000, memo: null }], score: 0.9, kind: "single" }))
      .rejects.toMatchObject({ code: "ynab_error" });
    expect((await db().select().from(matches).where(eq(matches.intentId, i.id)).get())).toMatchObject({ state: "failed" });
    expect((await L.excludedTxnIds(db(), userId, PLAN)).has(t.id)).toBe(false);
  });

  it("refuses an allocation that does not add up, and matched lines", async () => {
    const i = await seed({ payee: "Costco", total: 10000 });
    const t = mkTxn({ id: uid("t"), amount: -10000 });
    fake.seed(t); // manual matches read the txn live
    await cacheTxns(userId, [t]);
    await expect(A.applyMatch(ctx(), { intentId: i.id, txnId: t.id, lineIds: i.lineIds, allocation: [{ categoryId: "c", amount: -9990, memo: null }], score: null, kind: "manual" }))
      .rejects.toMatchObject({ code: "validation" });
    await db().update(intentLines).set({ status: "matched" }).where(eq(intentLines.intentId, i.id));
    await expect(A.applyMatch(ctx(), { intentId: i.id, txnId: t.id, lineIds: i.lineIds, allocation: [{ categoryId: "c", amount: -10000, memo: null }], score: null, kind: "manual" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("never writes an approved, categorized import outside a review/manual match", async () => {
    const i = await seed({ payee: "Costco", total: 10000 });
    const t = mkTxn({ id: uid("t"), amount: -10000, approved: true, categoryId: "cat-household" });
    fake.seed(t);
    await cacheTxns(userId, [t]);
    await expect(A.applyMatch(ctx(), { intentId: i.id, txnId: t.id, lineIds: i.lineIds, allocation: [{ categoryId: "cat-groceries", amount: -10000, memo: null }], score: 0.95, kind: "single" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(fake.callsOf("updateTransactions")).toHaveLength(0);
  });

  it("a failed placeholder delete keeps the intent open; the next cycle finishes it", async () => {
    const i = await withPlaceholder({ payee: "Costco", total: 10000 });
    const t = mkTxn({ id: uid("t"), amount: -10000, importPayeeName: "COSTCO" });
    fake.seed(t);
    await cacheTxns(userId, [t]);
    fake.failNext("deleteTransaction", () => new E.AppError("ynab_error", "down"));
    await expect(A.applyMatch(ctx(), { intentId: i.id, txnId: t.id, lineIds: i.lineIds, allocation: [{ categoryId: "cat-groceries", amount: -10000, memo: null }], score: null, kind: "manual" }))
      .rejects.toMatchObject({ code: "ynab_error" });
    expect((await intentRow(i.id)).status).toBe("pending");
    expect((await db().select().from(matches).where(eq(matches.intentId, i.id)).get())?.state).toBe("applied");
    const s = await R.reconcileUser(ctx(), DELTA);
    expect(s.errors).toEqual([]);
    expect(await intentRow(i.id)).toMatchObject({ status: "resolved", placeholderStatus: "deleted" });
  });
});

describe("safeDeletePlaceholder (§10.7)", () => {
  it("404 → gone and status deleted", async () => {
    const i = await withPlaceholder({ payee: "Costco", total: 10000 });
    fake.txns.delete(i.phId);
    expect(await P.safeDeletePlaceholder(ctx(), i.id, "cancelled")).toBe("gone");
    expect((await intentRow(i.id)).placeholderStatus).toBe("deleted");
  });
  it.each([
    ["matched_transaction_id", { matchedTransactionId: "x" }],
    ["cleared", { cleared: "cleared" as const }],
    ["amount changed", { amount: -5 }],
    ["tag removed", { memo: "edited" }],
    ["split", { isSplit: true }],
  ])("refuses when %s; no review when cancelling", async (_n, change) => {
    const i = await withPlaceholder({ payee: "Costco", total: 10000 });
    Object.assign(fake.txns.get(i.phId)!, change);
    expect(await P.safeDeletePlaceholder(ctx(), i.id, "cancelled")).toBe("refused");
    expect(fake.callsOf("deleteTransaction")).toHaveLength(0);
    expect(await openReviewsOf()).toHaveLength(0);
    expect(await auditActions(i.id)).toContain("placeholder_delete_refused");
  });
  it("stale_delete refusal opens a ynab_matched_other review", async () => {
    const i = await withPlaceholder({ payee: "Costco", total: 10000 });
    fake.txns.get(i.phId)!.importId = "YNAB:x";
    expect(await P.safeDeletePlaceholder(ctx(), i.id, "stale_delete")).toBe("refused");
    expect(await openReviewsOf()).toEqual([expect.objectContaining({ kind: "ynab_matched_other", intentId: i.id })]);
  });
  it("non-created placeholders are never touched", async () => {
    const i = await seed({ payee: "Costco", total: 10000, placeholderStatus: "missing", placeholderTxnId: "gone-1" });
    expect(await P.safeDeletePlaceholder(ctx(), i.id, "resolved")).toBe("gone");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("excludedTxnIds / countOpen", () => {
  it("excludedTxnIds covers placeholders (not none/failed), live matches, open reviews only", async () => {
    await seed({ payee: "A", total: 1000, placeholderTxnId: "ph-ok", placeholderStatus: "created" });
    await seed({ payee: "B", total: 1000, placeholderTxnId: "ph-final", placeholderStatus: "final" });
    await seed({ payee: "C", total: 1000, placeholderTxnId: "ph-failed", placeholderStatus: "failed" });
    const d = await seed({ payee: "D", total: 1000 });
    const mk = (txn: string, state: "planned" | "applied" | "failed") => db().insert(matches).values({
      id: uid("m"), userId, intentId: d.id, ynabTxnId: txn, kind: "manual", lineIds: "[]", allocation: "[]", score: null, state, error: null, createdAt: Date.now(), appliedAt: null,
    });
    await mk("m-planned", "planned");
    await mk("m-applied", "applied");
    await mk("m-failed", "failed");
    const opt = (t: string) => ({ id: "o1", label: "x", intentId: d.id, transactionId: t, lineIds: [], allocation: [], score: 1 });
    await db().insert(reviews).values([
      { id: uid("r"), userId, intentId: null, ynabTxnId: "r-txn", kind: "amazon_split", options: JSON.stringify([opt("r-opt")]), summary: "s", status: "open", createdAt: 1 },
      { id: uid("r"), userId, intentId: d.id, ynabTxnId: null, kind: "ambiguous_match", options: JSON.stringify([opt("r-dismissed")]), summary: "s", status: "dismissed", createdAt: 1 },
    ]);
    expect(await L.excludedTxnIds(db(), userId, PLAN)).toEqual(new Set(["ph-ok", "ph-final", "m-planned", "m-applied", "r-txn", "r-opt"]));
  });

  it("countOpen", async () => {
    await seed({ payee: "A", total: 1000 });
    await seed({ payee: "B", total: 1000, status: "partial" });
    await seed({ payee: "C", total: 1000, expiresOn: "2026-11-01" });
    await seed({ payee: "D", total: 1000, status: "review", expiresOn: "2026-11-01" });
    await seed({ payee: "E", total: 1000, status: "resolved" });
    await db().insert(reviews).values({ id: uid("r"), userId, intentId: null, ynabTxnId: "x", kind: "amazon_split", options: "[]", summary: "s", status: "open", createdAt: 1 });
    expect(await R.countOpen(db(), userId, PLAN, TODAY)).toEqual({ pending: 2, stale: 2, review: 1 });
  });
});

describe("reconcileUser options", () => {
  it("onlyIntentIds limits decisions; stale count is reported", async () => {
    const a = await seed({ payee: "Costco", total: 200000 });
    const b = await seed({ payee: "Shell", total: 40000, expiresOn: "2026-11-01" });
    const t1 = mkTxn({ id: uid("t"), amount: -199000, importPayeeName: "COSTCO WHSE" });
    const t2 = mkTxn({ id: uid("t"), amount: -40000, importPayeeName: "SHELL OIL" });
    fake.seed(t1, t2);
    await cacheTxns(userId, [t1, t2]);
    const s = await R.reconcileUser(ctx({}, "user"), DELTA, { onlyIntentIds: [a.id] });
    expect(s).toMatchObject({ matched: 1, stale: 1 });
    expect((await intentRow(b.id)).status).toBe("pending");
    expect((await R.reconcileUser(ctx({}, "user"), DELTA)).matched).toBe(1);
    expect((await intentRow(b.id)).status).toBe("resolved");
  });

  it("errors in one decision do not stop the others", async () => {
    await seed({ payee: "Costco", total: 200000 });
    const b = await seed({ payee: "Shell", total: 40000 });
    const t1 = mkTxn({ id: uid("t"), amount: -199000, importPayeeName: "COSTCO WHSE" });
    const t2 = mkTxn({ id: uid("t"), amount: -40000, importPayeeName: "SHELL OIL" });
    fake.seed(t1, t2);
    await cacheTxns(userId, [t1, t2]);
    fake.failNext("updateTransactions", () => new E.AppError("ynab_error", "first fails"));
    const s = await R.reconcileUser(ctx(), DELTA);
    expect(s.matched).toBe(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain("ynab_error: first fails");
    expect((await intentRow(b.id)).status).toBe("resolved");
  });

  it("cron prunes old closed intents, old audit rows, unneeded old txns and expired sessions", async () => {
    const old = Date.now() - 100 * 86_400_000;
    const closed = await seed({ payee: "Old", total: 1000, status: "resolved", resolvedAt: old, updatedAt: old });
    const open = await seed({ payee: "Long", total: 1000, placeholderTxnId: "ph-old", placeholderStatus: "created" });
    await cacheTxns(userId, [mkTxn({ id: "ph-old", date: "2026-05-01", importId: null }), mkTxn({ id: uid("ancient"), date: "2026-05-01" })]);
    await db().insert(auditLog).values({ id: uid("a"), userId, at: Date.now() - 200 * 86_400_000, actor: "app", action: "login", summary: "old" });
    await db().insert(sessions).values({ idHash: uid("s"), userId, createdAt: 1, lastSeenAt: 1, expiresAt: 2 });
    fake.seed(mkTxn({ id: "ph-old", date: "2026-05-01", importId: null, cleared: "uncleared" }));
    await R.reconcileUser(ctx({}, "cron"), DELTA);
    expect(await db().select().from(intents).where(eq(intents.id, closed.id)).get()).toBeUndefined();
    expect(await db().select().from(intents).where(eq(intents.id, open.id)).get()).toBeDefined();
    const left = await db().select({ id: ynabTransactions.id }).from(ynabTransactions).where(and(eq(ynabTransactions.userId, userId))).all();
    expect(left.map((x) => x.id)).toEqual(["ph-old"]);
    expect(await db().select().from(auditLog).where(and(eq(auditLog.userId, userId), eq(auditLog.summary, "old"))).all()).toHaveLength(0);
    expect(await db().select().from(sessions).where(eq(sessions.userId, userId)).all()).toHaveLength(0);
    expect(await db().select().from(users).where(eq(users.id, userId)).get()).toBeDefined();
  });
});

describe("reviews helpers", () => {
  it("detachIntentFromReviews removes the intent's options and releases intents left without a review", async () => {
    const a = await seed({ payee: "Amazon", total: 1000, status: "review" });
    const b = await seed({ payee: "Amazon", total: 1000, status: "review" });
    const opt = (intentId: string, k: string) => ({ id: k, label: k, intentId, transactionId: "c", lineIds: [], allocation: [], score: 1 });
    await db().insert(reviews).values({ id: uid("r"), userId, intentId: null, ynabTxnId: "c", kind: "amazon_split",
      options: JSON.stringify([opt(a.id, "o1"), opt(b.id, "o2")]), summary: "s", status: "open", createdAt: 1 });
    await RV.detachIntentFromReviews({ db: db(), userId, actor: "user" }, a.id);
    const [r] = await openReviewsOf();
    expect(JSON.parse(r!.options)).toHaveLength(1);
    expect((await intentRow(b.id)).status).toBe("review");
    await RV.detachIntentFromReviews({ db: db(), userId, actor: "user" }, b.id);
    expect(await openReviewsOf()).toHaveLength(0);
  });
  it("upsertOpenReview needs an intent or a txn", async () => {
    await expect(RV.upsertOpenReview({ db: db(), userId, actor: "cron" }, { intentId: null, txnId: null, kind: "too_complex", summary: "s", options: [] }))
      .rejects.toThrow();
  });
});

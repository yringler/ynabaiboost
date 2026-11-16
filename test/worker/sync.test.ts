// WP3: syncPlan (initial then delta, tombstones, split flag, payee-name fill-in) and the cache queries.
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, todayIn } from "../../src/shared/dates";
import { getDb } from "../../src/worker/db/client";
import { syncState, users, ynabCategories, ynabCategoryGroups, ynabTransactions } from "../../src/worker/db/schema";
import {
  getAccounts, getAllPayees, getCachedTxns, getCurrency, getRecentCategoryIds, getSelectableCategories, getTopPayees,
  getUncategorizedIds, isUncategorized, lastAccountForPayee, toTxnView,
  upsertTxnsStmts,
} from "../../src/worker/ynab/cache";
import { createYnabClientForToken } from "../../src/worker/ynab/client";
import { syncPlan } from "../../src/worker/ynab/sync";
import type { YnabTxn } from "../../src/worker/ynab/types";
import { PLAN_ID, seedPlan, txn } from "../fixtures/ynab/plan";
import { FakeYnab } from "../msw/ynab";

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const db = getDb(env);
const today = todayIn("UTC");
let n = 0;
let uid = "";
let fake: FakeYnab;
const client = () => createYnabClientForToken("tok");

beforeEach(async () => {
  uid = `sync-user-${++n}`;
  await db.insert(users).values({ id: uid, authType: "pat", createdAt: 1, lastSeenAt: 1 });
  fake = new FakeYnab(seedPlan(today));
  network.use(...fake.handlers());
});

const state = () => db.select().from(syncState).where(and(eq(syncState.userId, uid), eq(syncState.planId, PLAN_ID))).get();
const cachedRow = (id: string) => db.select().from(ynabTransactions).where(and(eq(ynabTransactions.userId, uid), eq(ynabTransactions.id, id))).get();

describe("syncPlan", () => {
  it("initial sync: 5 requests, caches everything, stores the minimum knowledge and currency", async () => {
    fake.plan(PLAN_ID).currency = { iso_code: "EUR", decimal_digits: 2 };
    const d = await syncPlan(env, db, client(), uid, PLAN_ID);
    expect(d.initial).toBe(true);
    expect(d.serverKnowledge).toBe(fake.knowledge);
    expect(d.deletedTxnIds).toEqual([]);
    expect(d.changedTxnIds.sort()).toEqual(seedPlan(today).transactions.map((t) => t.id).sort());
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /plans/plan-1/settings", "GET /plans/plan-1/categories", "GET /plans/plan-1/accounts", "GET /plans/plan-1/payees",
      "GET /plans/plan-1/transactions",
    ]);
    expect(fake.requests[4]?.search.get("since_date")).toBe(addDays(today, -120));
    const s = await state();
    expect(s).toMatchObject({ serverKnowledge: fake.knowledge, currencyIso: "EUR", currencyDecimals: 2 });
    expect(s?.lastSyncAt).toBeGreaterThan(0);
    expect(await cachedRow("t-split")).toMatchObject({ isSplit: true, payeeName: "Amazon" });
    expect(await getCurrency(db, uid, PLAN_ID)).toEqual({ isoCode: "EUR", decimalDigits: 2, planName: null });
  });

  it("initial sync uses the minimum knowledge across resources", async () => {
    const c = client();
    const wrapped = { ...c, getPayees: async (p: string, k?: number) => ({ ...(await c.getPayees(p, k)), serverKnowledge: 7 }) };
    const d = await syncPlan(env, db, wrapped, uid, PLAN_ID);
    expect(d.serverKnowledge).toBe(7);
    expect((await state())?.serverKnowledge).toBe(7);
  });

  it("delta sync: 1 request; upserts changes and tombstones; fills payee names from the cache", async () => {
    await syncPlan(env, db, client(), uid, PLAN_ID);
    const k0 = fake.knowledge;
    fake.putTxn(PLAN_ID, txn("t-new", today, -173_500, { payee_id: "p-costco", import_id: "YNAB:-173500:1", import_payee_name_original: "COSTCO WHSE #0123" }));
    fake.updateTxn(PLAN_ID, "t-sbux-2", { category_id: "c-dining", approved: true });
    fake.updateTxn(PLAN_ID, "t-sbux-1", { deleted: true });
    fake.updateTxn(PLAN_ID, "t-split", { memo: "parent only" });     // subtransactions unchanged → not in the delta
    fake.putCategory(PLAN_ID, { id: "c-new", category_group_id: "g-everyday", name: "Gifts", hidden: false, deleted: false, budgeted: 0, activity: 0, balance: 0 });
    fake.putGroup(PLAN_ID, { id: "g-bills", name: "Bills", hidden: true, deleted: false });
    fake.putAccount(PLAN_ID, { ...seedPlan(today).accounts[1]!, direct_import_linked: true });
    fake.requests = [];

    const d = await syncPlan(env, db, client(), uid, PLAN_ID);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /plans/plan-1"]);
    expect(fake.requests[0]?.search.get("last_knowledge_of_server")).toBe(String(k0));
    expect(d).toMatchObject({ initial: false, serverKnowledge: fake.knowledge, deletedTxnIds: ["t-sbux-1"] });
    expect(d.changedTxnIds.sort()).toEqual(["t-new", "t-sbux-2", "t-split"]);

    expect(await cachedRow("t-new")).toMatchObject({ payeeName: "Costco", amount: -173_500, importId: "YNAB:-173500:1", deleted: false });
    expect(await cachedRow("t-sbux-2")).toMatchObject({ categoryId: "c-dining", approved: true, payeeName: "Starbucks" });
    expect(await cachedRow("t-sbux-1")).toMatchObject({ deleted: true });
    expect(await cachedRow("t-split")).toMatchObject({ isSplit: true, memo: "parent only" });
    expect((await state())?.serverKnowledge).toBe(fake.knowledge);

    // catalog changes: new category sorts last, group hidden flag propagates, account becomes linked
    const cats = await getSelectableCategories(db, uid, PLAN_ID);
    expect(cats.at(-1)?.id).toBe("c-new");
    expect(cats.map((c) => c.id)).not.toContain("c-electric");
    expect((await getAccounts(db, uid, PLAN_ID)).find((a) => a.id === "acc-cash")?.directImportLinked).toBe(true);

    // a no-op delta changes nothing
    const d2 = await syncPlan(env, db, client(), uid, PLAN_ID);
    expect(d2).toMatchObject({ changedTxnIds: [], deletedTxnIds: [] });
  });

  it("delta sync: a new split via subtransactions sets is_split", async () => {
    await syncPlan(env, db, client(), uid, PLAN_ID);
    fake.updateTxn(PLAN_ID, "t-power", { category_id: null });
    fake.putSub(PLAN_ID, { id: "s-p1", transaction_id: "t-power", amount: -30_000, memo: null, payee_id: null, category_id: "c-electric", transfer_account_id: null, deleted: false });
    await syncPlan(env, db, client(), uid, PLAN_ID);
    expect(await cachedRow("t-power")).toMatchObject({ isSplit: true });
  });

  it("delta sync prunes txns older than 180 days", async () => {
    await syncPlan(env, db, client(), uid, PLAN_ID);
    const old: YnabTxn = {
      id: "t-ancient", planId: PLAN_ID, date: addDays(today, -200), amount: -1, payeeId: null, payeeName: null, importPayeeName: null,
      importPayeeNameOriginal: null, accountId: "acc-checking", categoryId: null, memo: null, cleared: "cleared", approved: true,
      flagColor: null, importId: null, matchedTransactionId: null, transferAccountId: null, isSplit: false, deleted: false,
    };
    const [s] = upsertTxnsStmts(db, uid, PLAN_ID, [old]);
    await s;
    expect(await cachedRow("t-ancient")).toBeDefined();
    await syncPlan(env, db, client(), uid, PLAN_ID);
    expect(await cachedRow("t-ancient")).toBeUndefined();
  });

  it("re-running the initial sync (knowledge reset) rebuilds the cache from scratch", async () => {
    await syncPlan(env, db, client(), uid, PLAN_ID);
    await db.update(syncState).set({ serverKnowledge: null }).where(eq(syncState.userId, uid));
    fake.plan(PLAN_ID).transactions.delete("t-power");
    const d = await syncPlan(env, db, client(), uid, PLAN_ID);
    expect(d.initial).toBe(true);
    expect(await cachedRow("t-power")).toBeUndefined();
  });

  it("does not advance knowledge when a request fails", async () => {
    await syncPlan(env, db, client(), uid, PLAN_ID);
    const k = (await state())?.serverKnowledge;
    fake.putTxn(PLAN_ID, txn("t-x", today, -1));
    fake.failNext("GET", /^\/plans\/plan-1$/, 500);
    await expect(syncPlan(env, db, client(), uid, PLAN_ID)).rejects.toMatchObject({ code: "ynab_error" });
    expect((await state())?.serverKnowledge).toBe(k);
  });

  it("upserts many transactions within D1 parameter limits", async () => {
    for (let i = 0; i < 230; i++) fake.putTxn(PLAN_ID, txn(`bulk-${i}`, today, -(i + 1) * 10, { payee_id: "p-amazon" }));
    await syncPlan(env, db, client(), uid, PLAN_ID);
    const rows = await getCachedTxns(db, uid, PLAN_ID, {});
    expect(rows.length).toBe(230 + seedPlan(today).transactions.length);
  });
});

describe("cache queries", () => {
  beforeEach(async () => {
    await syncPlan(env, db, client(), uid, PLAN_ID);
  });

  it("getSelectableCategories excludes deleted, hidden (own or group), internal and CC payment; keeps YNAB order", async () => {
    const cats = await getSelectableCategories(db, uid, PLAN_ID);
    expect(cats).toEqual([
      { id: "c-groceries", groupId: "g-everyday", groupName: "Everyday", name: "Groceries" },
      { id: "c-dining", groupId: "g-everyday", groupName: "Everyday", name: "Dining Out" },
      { id: "c-electric", groupId: "g-bills", groupName: "Bills", name: "Electric" },
    ]);
  });

  it("a deleted group hides its categories", async () => {
    await db.update(ynabCategoryGroups).set({ deleted: true }).where(and(eq(ynabCategoryGroups.userId, uid), eq(ynabCategoryGroups.id, "g-bills")));
    expect((await getSelectableCategories(db, uid, PLAN_ID)).map((c) => c.id)).toEqual(["c-groceries", "c-dining"]);
  });

  it("getAccounts: open, non-deleted, with directImportLinked", async () => {
    const accts = await getAccounts(db, uid, PLAN_ID);
    expect(accts.map((a) => a.id).sort()).toEqual(["acc-cash", "acc-checking", "acc-visa"]);
    expect(accts.find((a) => a.id === "acc-cash")).toEqual({ id: "acc-cash", name: "Wallet", type: "cash", onBudget: true, closed: false, directImportLinked: false });
  });

  it("getAllPayees / getTopPayees skip transfer and system payees; top is ordered by use", async () => {
    expect((await getAllPayees(db, uid, PLAN_ID)).map((p) => p.name)).toEqual(["Amazon", "City Power", "Costco", "Starbucks"]);
    const top = await getTopPayees(db, uid, PLAN_ID, 2);
    expect(top.map((p) => p.id)).toEqual(["p-costco", "p-amazon"]);
  });

  it("getRecentCategoryIds: most used selectable categories", async () => {
    expect(await getRecentCategoryIds(db, uid, PLAN_ID, 15)).toEqual(["c-groceries", "c-dining", "c-electric"]);
    expect(await getRecentCategoryIds(db, uid, PLAN_ID, 1)).toEqual(["c-groceries"]);
  });

  it("getCachedTxns filters by date, ids and deleted", async () => {
    await db.update(ynabTransactions).set({ deleted: true }).where(and(eq(ynabTransactions.userId, uid), eq(ynabTransactions.id, "t-sbux-1")));
    const all = await getCachedTxns(db, uid, PLAN_ID, {});
    expect(all.map((t) => t.id)).not.toContain("t-sbux-1");
    expect(all[0]!.date >= all.at(-1)!.date).toBe(true);
    expect((await getCachedTxns(db, uid, PLAN_ID, { includeDeleted: true })).map((t) => t.id)).toContain("t-sbux-1");
    expect((await getCachedTxns(db, uid, PLAN_ID, { sinceDate: addDays(today, -2) })).map((t) => t.id).sort())
      .toEqual(["t-refund", "t-sbux-2", "t-uncat"].sort());
    expect((await getCachedTxns(db, uid, PLAN_ID, { ids: ["t-power", "t-split", "nope"] })).map((t) => t.id).sort()).toEqual(["t-power", "t-split"]);
    expect(await getCachedTxns(db, uid, PLAN_ID, { ids: [] })).toEqual([]);
    expect(await getCachedTxns(db, "someone-else", PLAN_ID, {})).toEqual([]);
  });

  it("isUncategorized / getUncategorizedIds", async () => {
    expect(await isUncategorized(db, uid, PLAN_ID, null)).toBe(true);
    expect(await isUncategorized(db, uid, PLAN_ID, "c-uncat")).toBe(true);
    expect(await isUncategorized(db, uid, PLAN_ID, "c-groceries")).toBe(false);
    expect([...(await getUncategorizedIds(db, uid, PLAN_ID))]).toEqual(["c-uncat"]);
  });

  it("lastAccountForPayee uses payee similarity ≥ 0.8 on the most recent txn", async () => {
    expect(await lastAccountForPayee(db, uid, PLAN_ID, "costco")).toBe("acc-visa");
    expect(await lastAccountForPayee(db, uid, PLAN_ID, "Starbucks")).toBe("acc-checking");
    expect(await lastAccountForPayee(db, uid, PLAN_ID, "Totally Unknown Shop")).toBeNull();
  });

  it("toTxnView maps names, uncategorized, transfer and import flags", async () => {
    const accounts = new Map((await getAccounts(db, uid, PLAN_ID)).map((a) => [a.id, a]));
    const unc = await getUncategorizedIds(db, uid, PLAN_ID);
    const [uncat, transfer] = await getCachedTxns(db, uid, PLAN_ID, { ids: ["t-uncat", "t-transfer"] }).then((ts) =>
      [ts.find((t) => t.id === "t-uncat")!, ts.find((t) => t.id === "t-transfer")!]);
    expect(toTxnView(uncat!, accounts, unc)).toEqual({
      id: "t-uncat", date: addDays(today, -1), amount: -9_990, payeeName: "Amazon", importPayeeName: "AMZN Mktp US*2K4L",
      accountId: "acc-checking", accountName: "Checking", categoryId: null, memo: null, approved: false, cleared: "cleared",
      isSplit: false, isTransfer: false, isImported: true,
    });
    expect(toTxnView(transfer!, accounts, unc)).toMatchObject({ isTransfer: true, isImported: false, accountName: "Visa" });
    expect(toTxnView({ ...transfer!, accountId: "gone" }, accounts, unc).accountName).toBe("Unknown account");
  });

  it("cache rows are scoped per user", async () => {
    const other = `${uid}-other`;
    await db.insert(users).values({ id: other, authType: "pat", createdAt: 1, lastSeenAt: 1 });
    expect(await getSelectableCategories(db, other, PLAN_ID)).toEqual([]);
    expect(await db.select().from(ynabCategories).where(eq(ynabCategories.userId, other)).all()).toEqual([]);
  });
});

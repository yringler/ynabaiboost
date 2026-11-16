// Review regressions: engine money paths (placeholder guard, prune keep-set, ynab_auto approval).
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn } from "../../../src/shared/dates";
import type { Settings } from "../../../src/shared/schemas";
import { intents, reviews, ynabAccounts } from "../../../src/worker/db/schema";
import type { YnabClient } from "../../../src/worker/ynab/client";
import type { PlanDelta } from "../../../src/worker/ynab/types";
import { PLAN, FakeYnab, cacheTxns, db, mkTxn, seedIntent, seedUser, settingsFor, uid } from "../wp5-helpers";

vi.mock("../../../src/worker/auth/settings", async () => {
  const { DEFAULT_SETTINGS } = await import("../../../src/shared/schemas");
  return { getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, planId: "plan-1", timezone: "UTC" })), updateSettings: vi.fn() };
});

let R: typeof import("../../../src/worker/engine/reconcile");
let A: typeof import("../../../src/worker/engine/apply");
let P: typeof import("../../../src/worker/engine/placeholders");
let S: typeof import("../../../src/worker/ynab/sync");
let T: typeof import("../../../src/worker/domain/tolerance");
beforeAll(async () => {
  vi.resetModules();
  R = await import("../../../src/worker/engine/reconcile");
  A = await import("../../../src/worker/engine/apply");
  P = await import("../../../src/worker/engine/placeholders");
  S = await import("../../../src/worker/ynab/sync");
  T = await import("../../../src/worker/domain/tolerance");
});

const TODAY = todayIn("UTC");
let userId: string;
let fake: FakeYnab;
const ctx = (over: Partial<Settings> = {}, actor: "user" | "cron" = "user") => ({
  env, db: db(), client: fake, userId, planId: PLAN, settings: settingsFor(over), currency: { isoCode: "USD", decimalDigits: 2 },
  today: TODAY, actor,
});
const seed = (s: Parameters<typeof seedIntent>[1]) => seedIntent(userId, s, (a, x) => T.computeTolerance(a, x));
const intentRow = async (id: string) => (await db().select().from(intents).where(eq(intents.id, id)).get())!;

beforeEach(async () => {
  userId = uid("user");
  fake = new FakeYnab();
  await seedUser(userId);
});

describe("placeholder safety: a real imported transaction must never be overwritten", () => {
  it("partial match (review/manual) re-amounts a placeholder that YNAB already merged with a bank import", async () => {
    // Amazon order, exact amounts: book 20.00 + case 25.20 → placeholder −45.20 (no nudge).
    const i = await seed({
      payee: "Amazon", merchantKind: "amazon", total: 45200, approximate: false, date: addDays(TODAY, -2),
      lines: [
        { description: "book", categoryId: "cat-books", amount: 20000 },
        { description: "case", categoryId: "cat-household", amount: 25200 },
      ],
    });
    expect((await P.createPlaceholder(ctx(), i.id)).kind).toBe("placeholder");
    const phId = (await intentRow(i.id)).placeholderTxnId!;

    // Meanwhile (before the 6-hourly cron) YNAB auto-matched the exact-amount placeholder with a real bank import.
    const p = fake.txns.get(phId)!;
    Object.assign(p, { importId: "YNAB:-45200:x:1", importPayeeName: "AMZN Mktp US*2K4L", cleared: "cleared" });

    // The user links (or resolves a review with) a separate 21.20 charge for the book only → intent becomes partial.
    const charge = mkTxn({ id: uid("c"), date: addDays(TODAY, -1), amount: -21200, importPayeeName: "AMZN Mktp US*9ZZ" });
    fake.seed(charge);
    await cacheTxns(userId, [charge]);
    await A.applyMatch(ctx(), {
      intentId: i.id, txnId: charge.id, lineIds: [i.lineIds[0]!],
      allocation: [{ categoryId: "cat-books", amount: -21200, memo: "book" }], score: null, kind: "manual",
    });

    // updatePlaceholderAmount PATCHed the merged, cleared bank transaction from −45.20 to −25.20.
    const writes = fake.callsOf("updateTransactions").flatMap((c) => c.args[1] as { id: string; amount?: number }[]);
    expect(writes.filter((u) => u.id === phId && u.amount !== undefined)).toEqual([]);
    expect(fake.txns.get(phId)!.amount).toBe(-45200);
  });

  it("delta sync prune drops an open intent's placeholder from the cache → reconcile marks it 'missing' and it is never deleted", async () => {
    // An intent dated > 180 days back (e.g. "January Costco ~200"), placeholder created and cached.
    const old = addDays(TODAY, -200);
    const i = await seed({ payee: "Costco", total: 200000, date: old, expiresOn: addDays(TODAY, 14) });
    expect((await P.createPlaceholder(ctx(), i.id)).kind).toBe("placeholder");
    const phId = (await intentRow(i.id)).placeholderTxnId!;
    expect(fake.txns.get(phId)!.deleted).toBe(false); // still alive in YNAB

    // A routine (empty) delta sync.
    const client = {
      async getPlanDelta(): Promise<PlanDelta> {
        return { serverKnowledge: 5, transactions: [], categoryGroups: [], categories: [], accounts: [], payees: [] };
      },
    } as unknown as YnabClient;
    const delta = await S.syncPlan(env, db(), client, userId, PLAN);
    await R.reconcileUser(ctx({}, "cron"), delta);

    // The placeholder still exists in YNAB, but the intent now believes the user deleted it.
    expect((await intentRow(i.id)).placeholderStatus).toBe("created");
  });

  it("auto-approve: a ynab_auto match (no score) is approved although §10.9 approves only manual/review or score ≥ 0.80", async () => {
    // Exact amount → YNAB auto-matched; payee similarity only has to reach 0.4 for ynab_auto.
    const i = await seed({ payee: "Shell", total: 47230, approximate: false, date: addDays(TODAY, -1),
      lines: [{ description: "gas", categoryId: "cat-fuel", amount: 47230 }] });
    expect((await P.createPlaceholder(ctx(), i.id)).kind).toBe("placeholder");
    const phId = (await intentRow(i.id)).placeholderTxnId!;
    const p = fake.txns.get(phId)!;
    // Merged in place; YNAB leaves the matched txn unapproved for the user to confirm (spike S1 pending).
    Object.assign(p, { importId: "YNAB:-47230:x:1", importPayeeName: "SHELL OIL 57444", cleared: "cleared", approved: false });
    await cacheTxns(userId, [p]);
    fake.calls = [];
    await R.reconcileUser(ctx({}, "cron"), { initial: false, changedTxnIds: [], deletedTxnIds: [], serverKnowledge: 2 });
    const u = fake.callsOf("updateTransactions").flatMap((c) => c.args[1] as Record<string, unknown>[]);
    expect(u.filter((x) => x.approved === true)).toEqual([]);
  });

  it("partial-match guard opens a ynab_matched_other review instead of writing", async () => {
    const i = await seed({
      payee: "Amazon", merchantKind: "amazon", total: 45200, approximate: false, date: addDays(TODAY, -2),
      lines: [
        { description: "book", categoryId: "cat-books", amount: 20000 },
        { description: "case", categoryId: "cat-household", amount: 25200 },
      ],
    });
    await P.createPlaceholder(ctx(), i.id);
    const phId = (await intentRow(i.id)).placeholderTxnId!;
    Object.assign(fake.txns.get(phId)!, { importId: "YNAB:-45200:x:1", cleared: "cleared" });
    await P.updatePlaceholderAmount(ctx(), i.id, 25200);
    expect(fake.callsOf("updateTransactions")).toHaveLength(0);
    const open = await db().select().from(reviews).where(eq(reviews.intentId, i.id)).all();
    expect(open).toEqual([expect.objectContaining({ kind: "ynab_matched_other", ynabTxnId: phId, status: "open" })]);
  });

  it("an untouched placeholder is still re-amounted after a partial match", async () => {
    const i = await seed({
      payee: "Amazon", merchantKind: "amazon", total: 45200, approximate: false, date: addDays(TODAY, -2),
      lines: [
        { description: "book", categoryId: "cat-books", amount: 20000 },
        { description: "case", categoryId: "cat-household", amount: 25200 },
      ],
    });
    await P.createPlaceholder(ctx(), i.id);
    const phId = (await intentRow(i.id)).placeholderTxnId!;
    await P.updatePlaceholderAmount(ctx(), i.id, 25200);
    expect(fake.txns.get(phId)!.amount).toBe(-25200);
  });
});

describe("account fallbacks skip tracking accounts", () => {
  it("createPlaceholder never writes to an off-budget account", async () => {
    await db().insert(ynabAccounts).values({ userId, planId: PLAN, id: "acc-401k", name: "401k", type: "otherAsset", onBudget: false, directImportLinked: true });
    const i = await seed({ payee: "Vanguard", total: 200000, accountId: "acc-401k" });
    const r = await P.createPlaceholder(ctx(), i.id);
    expect(r).toMatchObject({ ok: false, kind: "none" });
    expect(fake.callsOf("createTransaction")).toHaveLength(0);
  });

  it("lastAccountForPayee ignores txns on off-budget accounts", async () => {
    const C = await import("../../../src/worker/ynab/cache");
    await db().insert(ynabAccounts).values({ userId, planId: PLAN, id: "acc-401k", name: "401k", type: "otherAsset", onBudget: false, directImportLinked: true });
    await cacheTxns(userId, [
      mkTxn({ id: uid("v1"), date: addDays(TODAY, -1), accountId: "acc-401k", payeeName: "Vanguard" }),
      mkTxn({ id: uid("v2"), date: addDays(TODAY, -30), accountId: "acc-card", payeeName: "Vanguard" }),
    ]);
    expect(await C.lastAccountForPayee(db(), userId, PLAN, "Vanguard")).toBe("acc-card");
  });
});

describe("createPlaceholder: a D1 failure after the YNAB create never orphans the placeholder", () => {
  it("records the created id with a minimal write when the batch fails", async () => {
    const i = await seed({ payee: "Costco", total: 200000, date: addDays(TODAY, -1) });
    const real = db();
    let failed = false;
    const flaky = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "batch" && !failed) {
          return async () => {
            failed = true;
            throw new Error("D1 unavailable");
          };
        }
        const v: unknown = Reflect.get(target, prop, recv);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await P.createPlaceholder({ ...ctx(), db: flaky }, i.id);
    expect(r.ok).toBe(true);
    expect(failed).toBe(true);
    const row = await intentRow(i.id);
    const phId = [...fake.txns.keys()][0]!;
    expect(row).toMatchObject({ placeholderStatus: "created", placeholderTxnId: phId });
  });
});

describe("applyMatch reads interactive matches live", () => {
  it("a txn split in YNAB after the last sync goes to split_conflict, not a subtransactions write", async () => {
    const i = await seed({
      payee: "Amazon", merchantKind: "amazon", total: 37100, approximate: false, date: addDays(TODAY, -2),
      lines: [
        { description: "book", categoryId: "cat-books", amount: 20000 },
        { description: "case", categoryId: "cat-household", amount: 17100 },
      ],
    });
    const t = mkTxn({ id: uid("t"), date: addDays(TODAY, -1), amount: -37100, importPayeeName: "AMZN Mktp US" });
    await cacheTxns(userId, [t]);              // cached unsplit (06:00 cron)
    fake.seed({ ...t, isSplit: true });        // split by hand in YNAB at 09:00
    await A.applyMatch(ctx(), {
      intentId: i.id, txnId: t.id, lineIds: i.lineIds, score: null, kind: "review",
      allocation: [{ categoryId: "cat-books", amount: -20000, memo: "book" }, { categoryId: "cat-household", amount: -17100, memo: "case" }],
    });
    const writes = fake.callsOf("updateTransactions").flatMap((c) => c.args[1] as Record<string, unknown>[]);
    expect(writes.some((w) => w.subtransactions !== undefined)).toBe(false);
    const rv = await db().select().from(reviews).where(eq(reviews.intentId, i.id)).all();
    expect(rv.map((r) => r.kind)).toContain("split_conflict");
  });
});

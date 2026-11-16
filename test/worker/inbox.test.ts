// WP4: inbox selection (§9.5), rule-based + Claude suggestions, and the /api/inbox routes.
// YNAB is the WP3 FakeYnab, Claude is FakeAnthropic (both msw); WP5 excludedTxnIds/possibleIntentFor are mocked.
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn } from "../../src/shared/dates";
import type { InboxItem, PossibleIntent } from "../../src/shared/schemas";
import type * as InboxModule from "../../src/worker/ai/inbox";
import { deleteSecrets, putSecret } from "../../src/worker/auth/secrets";
import { getSettings, updateSettings } from "../../src/worker/auth/settings";
import { auditLog, inboxSuggestions, ynabAccounts, ynabTransactions } from "../../src/worker/db/schema";
import { getSelectableCategories } from "../../src/worker/ynab/cache";
import { createYnabClientForToken } from "../../src/worker/ynab/client";
import { syncPlan } from "../../src/worker/ynab/sync";
import { PLAN_ID, seedPlan, txn } from "../fixtures/ynab/plan";
import { apiError, FakeAnthropic, structured } from "../msw/anthropic";
import { FakeYnab } from "../msw/ynab";
import { call, db, envWith, loadFreshApp, seedSession, seedUser, uid } from "./wp2-helpers";

const wp5 = vi.hoisted(() => ({
  excluded: new Set<string>(),
  possible: new Map<string, { intentId: string; payee: string; totalAmount: number; date: string }>(),
}));
vi.mock("../../src/worker/engine/load", () => ({
  excludedTxnIds: vi.fn(async () => new Set(wp5.excluded)),
  possibleIntentFor: vi.fn(async (_db: unknown, _u: unknown, _p: unknown, txns: { id: string }[]) =>
    new Map([...wp5.possible].filter(([id]) => txns.some((t) => t.id === id)))),
}));

const network = setupNetwork();
// The pool loads the worker before vi.mock applies: re-import after resetting the registry (see wp2-helpers).
let inbox: typeof InboxModule;
beforeAll(async () => {
  network.enable();
  await loadFreshApp();
  inbox = await import("../../src/worker/ai/inbox");
});
const listInbox: typeof InboxModule.listInbox = (c) => inbox.listInbox(c);
const countInbox: typeof InboxModule.countInbox = (...a) => inbox.countInbox(...a);
const suggestInboxCategories: typeof InboxModule.suggestInboxCategories = (...a) => inbox.suggestInboxCategories(...a);
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const today = todayIn("UTC");
const d = (n: number) => addDays(today, n);
const E = envWith({ ALLOWED_USER_IDS: "*" });
let user = "";
let cookie = "";
let ynab: FakeYnab;
let claude: FakeAnthropic;

/** Seed plan + extra txns for each suggestion source. */
function plan() {
  const p = seedPlan(today);
  p.transactions.push(
    // ynab_existing: unapproved import with YNAB's payee-memory category
    txn("t-existing", d(-2), -15_000, { payee_id: "p-starbucks", category_id: "c-dining", approved: false, import_id: "YNAB:-15000:1" }),
    // dominant history for City Power: 3 approved Electric (t-power + 2 more), then one unapproved import
    txn("t-power-2", d(-50), -61_000, { payee_id: "p-power", category_id: "c-electric", approved: true }),
    txn("t-power-3", d(-80), -59_000, { payee_id: "p-power", category_id: "c-electric", approved: true }),
    txn("t-power-new", d(-1), -62_000, { payee_id: "p-power", category_id: null, approved: false, import_id: "YNAB:-62000:1",
      import_payee_name_original: "CITY POWER AUTOPAY" }),
    // outside the 60-day window
    txn("t-old", d(-61), -1_000, { payee_id: "p-starbucks", category_id: null, approved: false }),
  );
  return p;
}

beforeEach(async () => {
  user = uid("inbox");
  await seedUser(user);
  cookie = (await seedSession(user)).cookie;
  await updateSettings(db(), user, { planId: PLAN_ID, timezone: "UTC", aiDataConsent: true });
  await putSecret(env, db(), user, "anthropic", "sk-ant-test-key");
  await putSecret(env, db(), user, "ynab_pat", "ynab-pat-token");
  ynab = new FakeYnab(plan());
  claude = new FakeAnthropic();
  network.use(...ynab.handlers(), ...claude.handlers());
  await syncPlan(env, db(), createYnabClientForToken("ynab-pat-token"), user, PLAN_ID);
  wp5.excluded.clear();
  wp5.possible.clear();
});

async function aiCtx(over: Partial<{ aiDataConsent: boolean }> = {}) {
  const settings = { ...(await getSettings(db(), user)), ...over };
  return { env, db: db(), userId: user, planId: PLAN_ID, settings };
}
const byId = (items: InboxItem[]) => new Map(items.map((i) => [i.transaction.id, i]));

describe("listInbox selection (§9.5)", () => {
  it("includes unapproved / uncategorized txns in the window; excludes splits, transfers, approved+categorized and old ones", async () => {
    const items = await listInbox(await aiCtx());
    expect(items.map((i) => i.transaction.id).sort()).toEqual(["t-existing", "t-power-new", "t-refund", "t-sbux-2", "t-uncat"]);
    // newest first
    const dates = items.map((i) => i.transaction.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    // internal Uncategorized reads as null in the view
    expect(byId(items).get("t-uncat")?.transaction.categoryId).toBeNull();
  });

  it("suggestion sources: ynab_existing, refund history, dominant history; the rest have none until Claude runs", async () => {
    const m = byId(await listInbox(await aiCtx()));
    expect(m.get("t-existing")?.suggestion).toEqual({ categoryId: "c-dining", confidence: "high", source: "ynab_existing", reason: "Category set by YNAB" });
    expect(m.get("t-refund")?.suggestion).toEqual({ categoryId: "c-groceries", confidence: "high", source: "history", reason: "Refund: last purchase here was Groceries" });
    expect(m.get("t-power-new")?.suggestion).toMatchObject({ categoryId: "c-electric", source: "history", reason: "Usually Electric (3 of 3)" });
    expect(m.get("t-sbux-2")?.suggestion).toBeNull();
    expect(m.get("t-uncat")?.suggestion).toBeNull();
  });

  it("hides txns in excludedTxnIds and attaches possible intents", async () => {
    wp5.excluded.add("t-uncat");
    const pi: PossibleIntent = { intentId: "intent-1", payee: "Starbucks", totalAmount: 6_000, date: d(-1) };
    wp5.possible.set("t-sbux-2", pi);
    const m = byId(await listInbox(await aiCtx()));
    expect(m.has("t-uncat")).toBe(false);
    expect(m.get("t-sbux-2")?.possibleIntent).toEqual(pi);
    expect(m.get("t-existing")?.possibleIntent).toBeNull();
    expect(await countInbox(db(), user, PLAN_ID)).toBe(4);
  });
});

describe("suggestInboxCategories", () => {
  it("asks Claude only for txns without a rule or stored suggestion; maps refs and stores rows", async () => {
    // The batch is ordered newest first: t-sbux-2 (d-1) and t-uncat (d-1) → sorted by date desc, id asc.
    const cats = await getSelectableCategories(db(), user, PLAN_ID);
    const dining = `c${cats.findIndex((c) => c.id === "c-dining") + 1}`;
    claude.reply(structured({ suggestions: [
      { txn_ref: "t1", category_ref: dining, confidence: "medium", reason: "Coffee shop" },
      { txn_ref: "t2", category_ref: "c99", confidence: "high", reason: "Bogus ref" },
      { txn_ref: "t7", category_ref: "c1", confidence: "high", reason: "Unknown txn ref" },
    ] }));
    const n = await suggestInboxCategories(await aiCtx(), { max: 25, effort: "medium" });
    expect(n).toBe(2);
    expect(claude.requests).toHaveLength(1);
    const req = claude.requests[0]!.body;
    expect(req.max_tokens).toBe(16000);
    expect(req.output_config?.effort).toBe("medium");
    const system = req.system as { text: string; cache_control?: unknown }[];
    expect(system[0]).not.toHaveProperty("cache_control");
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]?.text).toContain(`${dining} | Everyday > Dining Out`);
    expect(system[1]?.text).not.toContain("Hidden Own");               // only selectable categories
    const turn = String(req.messages[0]?.content);
    expect(turn).toContain(`| payee "Starbucks" | bank "STARBUCKS STORE 123" |`);
    expect(turn).toMatch(new RegExp(`^t1 \\| .* \\| -6\\.10 \\| payee "Starbucks" .* \\| HISTORY: ${dining}×1$`, "m"));
    expect(turn).toMatch(/^t2 \| .* \| -9\.99 \| payee "Amazon" \| bank "AMZN Mktp US\*2K4L" \|/m);
    expect(turn).not.toContain("t3 |");

    const rows = await db().select().from(inboxSuggestions).where(eq(inboxSuggestions.userId, user)).all();
    const r = new Map(rows.map((x) => [x.ynabTxnId, x]));
    expect(r.get("t-sbux-2")).toMatchObject({ categoryId: "c-dining", confidence: "medium", source: "claude", status: "suggested", reason: "Coffee shop" });
    expect(r.get("t-uncat")).toMatchObject({ categoryId: null, confidence: "low", source: "claude" });

    const m = byId(await listInbox(await aiCtx()));
    expect(m.get("t-sbux-2")?.suggestion).toEqual({ categoryId: "c-dining", confidence: "medium", source: "claude", reason: "Coffee shop" });

    // nothing left to ask
    expect(await suggestInboxCategories(await aiCtx(), { max: 25, effort: "medium" })).toBe(0);
    expect(claude.requests).toHaveLength(1);
  });

  it("returns 0 without consent or without a key, and makes no request", async () => {
    expect(await suggestInboxCategories(await aiCtx({ aiDataConsent: false }), { max: 25, effort: "medium" })).toBe(0);
    await deleteSecrets(db(), user, ["anthropic"]);
    expect(await suggestInboxCategories(await aiCtx(), { max: 25, effort: "medium" })).toBe(0);
    expect(claude.requests).toHaveLength(0);
  });

  it("batches at most 12 txns per call and respects max", async () => {
    for (let i = 0; i < 15; i++) {
      ynab.putTxn(PLAN_ID, txn(`t-bulk-${String(i).padStart(2, "0")}`, d(-5), -1_000 - i, { payee_id: null, import_payee_name_original: `SHOP ${i}`, import_id: `YNAB:x:${i}` }));
    }
    await syncPlan(env, db(), createYnabClientForToken("ynab-pat-token"), user, PLAN_ID);
    const reply = (n: number) => structured({ suggestions: Array.from({ length: n }, (_, i) => ({ txn_ref: `t${i + 1}`, category_ref: "c1", confidence: "low", reason: "guess" })) });
    claude.reply(reply(12), reply(4));
    expect(await suggestInboxCategories(await aiCtx(), { max: 16, effort: "low" })).toBe(16);
    expect(claude.requests).toHaveLength(2);
    expect(String(claude.requests[0]!.body.messages[0]?.content).split("\n")).toHaveLength(13);   // header + 12
    expect(String(claude.requests[1]!.body.messages[0]?.content).split("\n")).toHaveLength(5);
    // identical system prefix across batches (cacheable)
    expect(claude.requests[0]!.body.system).toEqual(claude.requests[1]!.body.system);
  });

  it("throws Claude errors (the cycle records them) after keeping earlier batches", async () => {
    claude.reply(apiError(401, "authentication_error", "invalid x-api-key"));
    await expect(suggestInboxCategories(await aiCtx(), { max: 25, effort: "medium" })).rejects.toMatchObject({ code: "anthropic_key_invalid" });
  });
});

describe("routes", () => {
  it("GET /api/inbox returns InboxRes", async () => {
    const res = await call(E, "GET", "/api/inbox", { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ items: InboxItem[]; lastSyncAt: number | null }>();
    expect(body.items).toHaveLength(5);
    expect(body).toHaveProperty("lastSyncAt");
  });

  it("GET /api/inbox without a plan → 409 no_plan_selected", async () => {
    await updateSettings(db(), user, { planId: null });
    const res = await call(E, "GET", "/api/inbox", { cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "no_plan_selected" } });
  });

  it("POST /api/inbox/suggest surfaces a missing key; with a key returns { suggested }", async () => {
    await deleteSecrets(db(), user, ["anthropic"]);
    let res = await call(E, "POST", "/api/inbox/suggest", { cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "anthropic_key_missing" } });
    await putSecret(env, db(), user, "anthropic", "sk-ant-test-key");
    claude.reply(structured({ suggestions: [{ txn_ref: "t1", category_ref: "c1", confidence: "high", reason: "x" }] }));
    res = await call(E, "POST", "/api/inbox/suggest", { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggested: 1 });
  });

  it("POST /api/inbox/dismiss hides the txn until it changes", async () => {
    let res = await call(E, "POST", "/api/inbox/dismiss", { cookie, body: { transactionIds: ["t-sbux-2", "t-sbux-2"] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(byId(await listInbox(await aiCtx())).has("t-sbux-2")).toBe(false);
    // the txn changes in YNAB → next sync bumps its cache row → visible again
    ynab.updateTxn(PLAN_ID, "t-sbux-2", { memo: "changed" });
    await new Promise((r) => setTimeout(r, 5));
    await syncPlan(env, db(), createYnabClientForToken("ynab-pat-token"), user, PLAN_ID);
    expect(byId(await listInbox(await aiCtx())).has("t-sbux-2")).toBe(true);
    res = await call(E, "POST", "/api/inbox/dismiss", { cookie, body: { transactionIds: [] } });
    expect(res.status).toBe(400);
  });

  it("POST /api/inbox/approve: one bulk PATCH, cache + audit + suggestion updated, bad items reported", async () => {
    wp5.excluded.add("t-uncat");
    await db().insert(inboxSuggestions).values({ userId: user, ynabTxnId: "t-sbux-2", categoryId: "c-dining", confidence: "high",
      reason: "x", source: "claude", status: "suggested", createdAt: Date.now() });
    const res = await call(E, "POST", "/api/inbox/approve", { cookie, body: { items: [
      { transactionId: "t-sbux-2", categoryId: "c-dining" },
      { transactionId: "t-refund", categoryId: "c-groceries" },
      { transactionId: "t-uncat", categoryId: "c-groceries" },       // excluded (stale list)
      { transactionId: "t-split", categoryId: "c-groceries" },       // split
      { transactionId: "t-nope", categoryId: "c-groceries" },        // unknown
      { transactionId: "t-power-new", categoryId: "c-hidden-own" },  // hidden category
    ] } });
    expect(res.status).toBe(200);
    const body = await res.json<{ approved: number; failed: { transactionId: string; message: string }[] }>();
    expect(body.approved).toBe(2);
    expect(body.failed.map((f) => f.transactionId).sort()).toEqual(["t-nope", "t-power-new", "t-split", "t-uncat"]);

    const patches = ynab.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ transactions: [
      { id: "t-sbux-2", category_id: "c-dining", approved: true, flag_color: "purple" },
      { id: "t-refund", category_id: "c-groceries", approved: true, flag_color: "purple" },
    ] });

    const cached = await db().select().from(ynabTransactions).where(and(eq(ynabTransactions.userId, user), eq(ynabTransactions.id, "t-sbux-2"))).get();
    expect(cached).toMatchObject({ approved: true, categoryId: "c-dining", flagColor: "purple" });
    const audits = await db().select().from(auditLog).where(and(eq(auditLog.userId, user), eq(auditLog.action, "inbox_approved"))).all();
    expect(audits).toHaveLength(2);
    const a = audits.find((x) => x.ynabTxnId === "t-sbux-2");
    expect(JSON.parse(a?.beforeJson ?? "null")).toEqual({ categoryId: null, approved: false, memo: null, flagColor: null, isSplit: false });
    expect(JSON.parse(a?.afterJson ?? "null")).toEqual({ categoryId: "c-dining", approved: true, memo: null, flagColor: "purple", isSplit: false });
    expect(a?.summary).toBe("Approved Starbucks -$6.10 as Dining Out");
    const s = await db().select().from(inboxSuggestions).where(and(eq(inboxSuggestions.userId, user), eq(inboxSuggestions.ynabTxnId, "t-sbux-2"))).get();
    expect(s?.status).toBe("applied");
    expect(byId(await listInbox(await aiCtx())).has("t-sbux-2")).toBe(false);
  });

  it("tracking (off-budget) account txns never reach the inbox and are refused by approve (review fix)", async () => {
    await db().insert(ynabAccounts).values({ userId: user, planId: PLAN_ID, id: "acc-401k", name: "401k", type: "otherAsset", onBudget: false });
    await db().insert(ynabTransactions).values({
      userId: user, planId: PLAN_ID, id: "t-401k", date: d(-1), amount: 500_000, payeeId: null, payeeName: "Vanguard", importPayeeName: "VANGUARD",
      importPayeeNameOriginal: null, accountId: "acc-401k", categoryId: null, memo: null, cleared: "cleared", approved: false, flagColor: null,
      importId: "YNAB:500000:1", matchedTransactionId: null, transferAccountId: null, isSplit: false, deleted: false, updatedAt: Date.now(),
    });
    expect(byId(await listInbox(await aiCtx())).has("t-401k")).toBe(false);
    const res = await call(E, "POST", "/api/inbox/approve", { cookie, body: { items: [
      { transactionId: "t-401k", categoryId: "c-groceries" }, { transactionId: "t-sbux-2", categoryId: "c-dining" },
    ] } });
    const body = await res.json<{ approved: number; failed: { transactionId: string }[] }>();
    expect(body.approved).toBe(1);
    expect(body.failed.map((f) => f.transactionId)).toEqual(["t-401k"]);
    const patches = ynab.requests.filter((r) => r.method === "PATCH");
    expect(JSON.stringify(patches[0]?.body)).not.toContain("t-401k");
  });

  it("POST /api/inbox/approve with only bad items makes no YNAB call", async () => {
    const res = await call(E, "POST", "/api/inbox/approve", { cookie, body: { items: [{ transactionId: "t-nope", categoryId: "c-dining" }] } });
    expect(await res.json()).toEqual({ approved: 0, failed: [{ transactionId: "t-nope", message: "Transaction not found. Sync and try again." }] });
    expect(ynab.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("POST /api/inbox/approve validates the body", async () => {
    const res = await call(E, "POST", "/api/inbox/approve", { cookie, body: { items: [] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation" } });
  });
});

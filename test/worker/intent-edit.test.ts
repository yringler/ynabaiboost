// §9.6 conversational edit: POST /api/intents/edit (preview / auto-apply) and /api/intents/edit/apply, real D1,
// Claude answered through msw from the actual prompt (refs are read from it), YNAB through the WP5 FakeYnab.
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditRes, IntentRes } from "../../src/shared/api";
import { addDays, todayIn } from "../../src/shared/dates";
import { putSecret } from "../../src/worker/auth/secrets";
import { auditLog, editPlans, intentLines, intents } from "../../src/worker/db/schema";
import type { AppEnv } from "../../src/worker/env";
import { ANTHROPIC_MESSAGES_URL, messageBody } from "../msw/anthropic";
import { FakeYnab, db, mkTxn, seedIntent, seedUser, uid } from "./wp5-helpers";

const m = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, fake: null as unknown, userId: "" }));
vi.mock("../../src/worker/auth/settings", async () => {
  const { DEFAULT_SETTINGS } = await import("../../src/shared/schemas");
  return {
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, planId: "plan-1", timezone: "UTC", aiDataConsent: true, ...m.settings })),
    updateSettings: vi.fn(),
  };
});
vi.mock("../../src/worker/ynab/client", () => ({ createYnabClient: vi.fn(async () => m.fake), createYnabClientForToken: vi.fn() }));
vi.mock("../../src/worker/ynab/sync", () => ({
  syncPlan: vi.fn(async () => ({ initial: false, changedTxnIds: [], deletedTxnIds: [], serverKnowledge: 2 })),
}));
vi.mock("../../src/worker/jobs/cycle", () => ({
  withUserLock: vi.fn(async (_e: unknown, _d: unknown, _u: unknown, _p: unknown, fn: () => Promise<unknown>) => fn()),
  runUserCycle: vi.fn(), runCron: vi.fn(),
}));

const network = setupNetwork();
let app: Hono<AppEnv>;
let T: typeof import("../../src/worker/domain/tolerance");
beforeAll(async () => {
  network.enable();
  vi.resetModules();
  const H = await import("hono");
  const E = await import("../../src/worker/lib/errors");
  T = await import("../../src/worker/domain/tolerance");
  const { intentRoutes } = await import("../../src/worker/routes/intents");
  const { editRoutes } = await import("../../src/worker/routes/edit");
  const { getDb } = await import("../../src/worker/db/client");
  app = new H.Hono<AppEnv>();
  app.onError(E.errorHandler);
  app.use("*", async (c, next) => {
    c.set("db", getDb(c.env));
    c.set("userId", m.userId);
    await next();
  });
  app.route("/api", editRoutes);
  app.route("/api", intentRoutes);
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const TODAY = todayIn("UTC");
const D = (n: number) => addDays(TODAY, -n);
let userId: string;
let fake: FakeYnab;

/** Claude's reply is computed from the request (prompt), so tests can use the refs the Worker assigned. */
interface Seen { system: string; user: string; body: Record<string, unknown> }
let seen: Seen[] = [];
function claudeAnswers(...fns: ((p: Seen) => unknown)[]) {
  network.use(http.post(ANTHROPIC_MESSAGES_URL, async ({ request }) => {
    const body = (await request.json()) as { system: { text: string }[]; messages: { content: string }[] };
    const p: Seen = { system: body.system.map((b) => b.text).join("\n"), user: body.messages[0]!.content, body: body as unknown as Record<string, unknown> };
    seen.push(p);
    const fn = fns.shift();
    if (!fn) return HttpResponse.json({ type: "error", error: { type: "api_error", message: "no reply" } }, { status: 500, headers: { "x-should-retry": "false" } });
    return HttpResponse.json(messageBody([{ type: "text", text: JSON.stringify(fn(p)), citations: null }], "end_turn"));
  }));
}
const itemRef = (p: Seen, payee: string) => {
  const r = new RegExp(`^(i\\d+) \\| "${payee}"`, "m").exec(p.user)?.[1];
  if (!r) throw new Error(`no ref for ${payee} in:\n${p.user}`);
  return r;
};
const catRef = (p: Seen, name: string) => new RegExp(`^(c\\d+) \\| Everyday > ${name}$`, "m").exec(p.system)?.[1] ?? "c999";
const acctRef = (p: Seen, name: string) => new RegExp(`^(a\\d+) \\| ${name} \\|`, "m").exec(p.system)?.[1] ?? "a999";

const upd = (ref: string, o: Record<string, unknown> = {}) => ({
  type: "update_intent", intent_ref: ref, payee: null, date: null, account_ref: null, memo: null, total_amount: null, total_is_approximate: null, ...o,
});
const txn = (o: Record<string, unknown>) => ({
  payee: "Target", merchant_kind: "in_person", direction: "outflow", date: TODAY, account_ref: null, total_amount: 40,
  total_is_approximate: true, total_has_cents: false, order: null, clarity_note: null, memo: null, lines: [], ...o,
});

beforeEach(async () => {
  userId = uid("edit");
  m.userId = userId;
  m.settings = {};
  fake = new FakeYnab();
  m.fake = fake;
  seen = [];
  await seedUser(userId);
  await putSecret(env, db(), userId, "anthropic", "sk-ant-test-key");
});

async function req(path: string, body: unknown) {
  const res = await app.request(`https://app.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const edit = async (text: string, selectedIntentIds: string[] = []) => {
  const r = await req("/api/intents/edit", { text, selectedIntentIds, inputMode: "typed" });
  return { status: r.status, json: r.json, res: r.status === 200 ? EditRes.parse(r.json) : null };
};
const apply = async (token: string) => {
  const r = await req("/api/intents/edit/apply", { token });
  return { status: r.status, json: r.json, res: r.status === 200 ? EditRes.parse(r.json) : null };
};
const seed = (s: Parameters<typeof seedIntent>[1]) => seedIntent(userId, s, (a, x) => T.computeTolerance(a, x));
const row = async (id: string) => (await db().select().from(intents).where(eq(intents.id, id)).get())!;
const linesOf = (id: string) => db().select().from(intentLines).where(eq(intentLines.intentId, id)).orderBy(intentLines.idx).all();
const getIntent = async (id: string) => IntentRes.parse(await (await app.request(`https://app.test/api/intents/${id}`, {}, env)).json()).intent;

describe("POST /api/intents/edit → /apply", () => {
  it("previews a date change on the selected item, then applies it through the PATCH path with an audit row", async () => {
    const costco = await seed({ payee: "Costco", total: 200_000, date: D(2) });
    await seed({ payee: "Target", total: 40_000, date: D(1) });
    claudeAnswers((p) => ({ summary: "Moved Costco a day earlier", actions: [upd(itemRef(p, "Costco"), { date: D(3) })] }));

    const prev = await edit("that was actually the day before", [costco.id]);
    expect(prev.status).toBe(200);
    const shortDate = (d: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
    expect(prev.res).toMatchObject({
      applied: false, needsConfirmation: true, question: null, dropped: [], summary: "Moved Costco a day earlier",
      lines: [`Costco · date ${shortDate(D(2))} → ${shortDate(D(3))}`],
    });
    expect(prev.res?.token).toEqual(expect.any(String));
    expect((await row(costco.id)).intentDate).toBe(D(2));          // preview writes nothing to the intent

    // request policy and prompt content
    const body = seen[0]!.body as { model: string; output_config: { effort: string; format: { type: string } }; fallbacks: unknown; betas?: unknown; thinking?: unknown };
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.fallbacks).toBe("default");
    expect(body.thinking).toBeUndefined();
    expect(seen[0]!.user).toMatch(/^SELECTED: i1$/m);
    expect(seen[0]!.user).toMatch(/^i1 \| "Costco" .*\[selected\]/m);
    expect(seen[0]!.user).toMatch(/^i2 \| "Target" /m);
    expect(seen[0]!.user).toContain('REQUEST: """that was actually the day before"""');

    const done = await apply(prev.res!.token!);
    expect(done.status).toBe(200);
    expect(done.res).toMatchObject({ applied: true, token: null, results: [{ ok: true, error: null }] });
    const r = await row(costco.id);
    expect(r.intentDate).toBe(D(3));
    expect(r.rawText).toContain("that was actually the day before");
    const acts = await db().select().from(auditLog).where(eq(auditLog.userId, userId)).all();
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(["intent_updated", "intent_edit_conversational"]));
    expect(acts.find((a) => a.action === "intent_edit_conversational")?.summary).toBe('Edit "that was actually the day before": 1 of 1 change applied');

    // the token works once
    const again = await apply(prev.res!.token!);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: { code: "conflict" } });
  });

  it('"make it 212.47" recomputes precision deterministically: exact, 1-cent tolerance, placeholder updated', async () => {
    fake.seed(mkTxn({ id: "ph-1", amount: -200_010, memo: "≈ groceries [aib:PHREF1]", cleared: "uncleared", importId: null }));
    const costco = await seed({ payee: "Costco", total: 200_000, shortRef: "PHREF1", placeholderTxnId: "ph-1", placeholderStatus: "created", placeholderAmount: 200_010 });
    // as parse stores it for "costco about 200": the model reported no cents for the OLD total
    await db().update(intents).set({ rawText: "costco about 200", orderFacts: JSON.stringify({
      totalHasCents: false, lineAmounts: [200_000], lineQuantities: [1], itemSubtotal: null, tax: null, shipping: null,
      discount: null, giftCard: null, grandTotal: null, shipments: [], clarityNote: null,
    }) }).where(eq(intents.id, costco.id));
    claudeAnswers((p) => ({ summary: "Set Costco to 212.47", actions: [upd(itemRef(p, "Costco"), { total_amount: 212.47, total_is_approximate: false })] }));

    const prev = await edit("make it 212.47", [costco.id]);
    expect(prev.res?.lines).toEqual(["Costco · total ≈$200.00 → $212.47 (exact)"]);
    const done = await apply(prev.res!.token!);
    expect(done.res?.results).toEqual([{ line: "Costco · total ≈$200.00 → $212.47 (exact)", ok: true, error: null }]);
    const i = await getIntent(costco.id);
    expect(i.totalAmount).toBe(212_470);
    expect(i.approximate).toBe(false);
    expect(i.precision.level).toBe("exact");
    expect(i.tolerance).toBe(10);
    expect(i.lines.map((l) => l.amount)).toEqual([212_470]);
    expect(fake.txns.get("ph-1")?.amount).toBe(-212_470);           // same PATCH path: placeholder follows, no nudge
  });

  it("a model saying 'exact' for a number the user never wrote stays approximate", async () => {
    const costco = await seed({ payee: "Costco", total: 200_000 });
    claudeAnswers((p) => ({ summary: "x", actions: [upd(itemRef(p, "Costco"), { total_amount: 212.47, total_is_approximate: false })] }));
    const prev = await edit("bump it up a bit", [costco.id]);
    expect(prev.res?.lines).toEqual(["Costco · total ≈$200.00 → ≈$212.47 (approximate)"]);
    await apply(prev.res!.token!);
    expect((await getIntent(costco.id)).precision.level).toBe("approximate");
  });

  it("split off 30 for household: one PATCH with both lines, total kept", async () => {
    const costco = await seed({ payee: "Costco", total: 200_000 });
    claudeAnswers((p) => {
      const ref = itemRef(p, "Costco");
      return { summary: "Split 30 to Household", actions: [
        { type: "update_line", intent_ref: ref, line_number: 1, category_ref: null, amount: 170, amount_is_estimate: true, description: null },
        { type: "add_line", intent_ref: ref, category_ref: catRef(p, "Household"), amount: 30, amount_is_estimate: false, description: "household" },
      ] };
    });
    const prev = await edit("split off 30 for household", [costco.id]);
    expect(prev.res?.lines).toEqual([
      "Costco · line 1 (stuff): ≈$200.00 → ≈$170.00",
      "Costco · add Household ≈$30.00",                              // "30" has no cents: approximate (§9.5)
    ]);
    const done = await apply(prev.res!.token!);
    expect(done.res?.results.map((r) => r.ok)).toEqual([true, true]);
    const ls = await linesOf(costco.id);
    expect(ls.map((l) => [l.categoryId, l.amount])).toEqual([["cat-groceries", 170_000], ["cat-household", 30_000]]);
    expect((await row(costco.id)).totalAmount).toBe(200_000);
  });

  it("scoping: with a selection, an action on an unselected item is dropped with a reason; create_intent is allowed", async () => {
    m.settings = { defaultAccountId: "acc-card" };
    const costco = await seed({ payee: "Costco", total: 200_000 });
    const target = await seed({ payee: "Target", total: 40_000 });
    claudeAnswers((p) => ({ summary: "x", actions: [
      { type: "delete_intent", intent_ref: itemRef(p, "Target") },
      upd(itemRef(p, "Costco"), { memo: "bulk run" }),
      { type: "create_intent", transaction: txn({ lines: [{ description: "gas", category_ref: catRef(p, "Fuel"), category_confidence: "high", amount: null, amount_is_estimate: false, quantity: 1 }] }) },
    ] }));
    const prev = await edit("delete target, memo bulk run, and I also spent 40 at Target, gas", [costco.id]);
    expect(prev.res?.dropped).toEqual(["Target isn't selected. Select it to change it"]);
    expect(prev.res?.lines).toEqual(['Costco · memo → "bulk run"', "New: Target ≈$40.00 · Fuel · Visa"]);
    expect(prev.res?.needsConfirmation).toBe(true);
    const done = await apply(prev.res!.token!);
    expect(done.res?.results.map((r) => r.ok)).toEqual([true, true]);
    expect((await row(target.id)).status).toBe("pending");          // never touched
    expect((await row(costco.id)).memo).toBe("bulk run");
    const created = await db().select().from(intents).where(and(eq(intents.userId, userId), eq(intents.payee, "Target"), eq(intents.rawText, "delete target, memo bulk run, and I also spent 40 at Target, gas"))).all();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ totalAmount: 40_000, approximate: true, accountId: "acc-card", status: "pending" });
  });

  it("drops unknown refs, unknown categories and accounts, bad dates and amounts, with reasons", async () => {
    await seed({ payee: "Costco", total: 200_000 });
    claudeAnswers((p) => {
      const ref = itemRef(p, "Costco");
      return { summary: "x", actions: [
        upd("i99", { memo: "x" }),
        { type: "update_line", intent_ref: ref, line_number: 1, category_ref: "c999", amount: null, amount_is_estimate: null, description: null },
        upd(ref, { account_ref: "a77" }),
        upd(ref, { date: addDays(TODAY, 2) }),
        upd(ref, { total_amount: -5 }),
        { type: "remove_line", intent_ref: ref, line_number: 1 },
      ] };
    });
    const prev = await edit("chaos");
    expect(prev.res?.dropped).toEqual([
      "Claude referred to an item that isn't in your list (i99)",
      "Costco: that category isn't in your budget (the app never creates categories)",
      "Costco: that account isn't one of your budget accounts",
      `Costco: "${addDays(TODAY, 2)}" is not a date the app can use (future or more than a year ago)`,
      "Costco: the amount must be positive and at most 1,000,000",
      "Costco: can't remove every line; delete the item instead",
    ]);
    expect(prev.res).toMatchObject({ token: null, lines: [], applied: false });
  });

  it("selected ids of another user (or closed ones) are refused before any Claude call", async () => {
    const other = uid("other");
    await seedUser(other);
    const theirs = await seedIntent(other, { payee: "Secret", total: 10_000 });
    const closed = await seed({ payee: "Old", total: 5_000, status: "resolved" });
    claudeAnswers(() => ({ summary: "x", actions: [] }));
    for (const ids of [[theirs.id], [closed.id]]) {
      const r = await edit("delete these", ids);
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ error: { code: "conflict" } });
    }
    expect(seen).toHaveLength(0);
    expect(seen.some((s) => s.user.includes("Secret"))).toBe(false);
  });

  it("an apply token of another user is not found", async () => {
    const costco = await seed({ payee: "Costco", total: 200_000 });
    claudeAnswers((p) => ({ summary: "x", actions: [upd(itemRef(p, "Costco"), { memo: "m" })] }));
    const prev = await edit("memo m", [costco.id]);
    m.userId = uid("intruder");
    await seedUser(m.userId);
    const r = await apply(prev.res!.token!);
    expect(r.status).toBe(404);
    m.userId = userId;
    expect((await apply(prev.res!.token!)).res?.applied).toBe(true);
  });

  it("clarify is passed through: question, no token, nothing applied", async () => {
    await seed({ payee: "Costco", total: 200_000 });
    await seed({ payee: "Costco", total: 50_000 });
    claudeAnswers(() => ({ summary: "Which Costco?", actions: [{ type: "clarify", question: "Which Costco purchase, the $200 or the $50 one?" }] }));
    const prev = await edit("the Costco one was on the Amex");
    expect(prev.res).toMatchObject({ question: "Which Costco purchase, the $200 or the $50 one?", token: null, lines: [], applied: false });
    expect(seen[0]!.user).toMatch(/^SELECTED: none/m);
    expect(await db().select().from(editPlans).where(eq(editPlans.userId, userId)).all()).toHaveLength(0);
  });

  it("apply re-validates: an item changed since the preview fails with a reason, the others still run", async () => {
    const costco = await seed({ payee: "Costco", total: 200_000 });
    const target = await seed({ payee: "Target", total: 40_000 });
    claudeAnswers((p) => ({ summary: "x", actions: [upd(itemRef(p, "Costco"), { memo: "a" }), { type: "extend", intent_ref: itemRef(p, "Target"), days: 7 }] }));
    const prev = await edit("memo a and give target another week");
    await db().update(intents).set({ updatedAt: Date.now() + 5 }).where(eq(intents.id, costco.id));
    const done = await apply(prev.res!.token!);
    expect(done.res?.results).toEqual([
      { line: 'Costco · memo → "a"', ok: false, error: "Costco changed since the preview. Preview the edit again" },
      { line: expect.stringMatching(/^Target · keep watching 7 more days/), ok: true, error: null },
    ]);
    expect((await row(costco.id)).memo).toBeNull();
    expect((await row(target.id)).expiresOn).toBe(addDays("2026-12-31" > TODAY ? "2026-12-31" : TODAY, 7));
  });

  it("per-action failure is reported (no silent partial success)", async () => {
    const review = await seed({ payee: "Costco", total: 200_000 });
    const target = await seed({ payee: "Target", total: 40_000 });
    claudeAnswers((p) => ({ summary: "x", actions: [{ type: "keep_final", intent_ref: itemRef(p, "Target") }, { type: "delete_intent", intent_ref: itemRef(p, "Costco") }] }));
    const prev = await edit("keep target, delete costco");
    expect(prev.res?.dropped).toEqual(["Target has no placeholder in YNAB to keep as final"]);
    const done = await apply(prev.res!.token!);
    expect(done.res?.results).toEqual([{ line: "Delete: Costco ≈$200.00", ok: true, error: null }]);
    expect((await row(review.id)).status).toBe("cancelled");
    expect((await row(target.id)).status).toBe("pending");
  });
});

describe("auto-apply setting (Apply voice edits without confirming)", () => {
  beforeEach(() => {
    m.settings = { autoApplyEdits: true };
  });

  it("applies at once and returns the same summary", async () => {
    const costco = await seed({ payee: "Costco", total: 200_000 });
    claudeAnswers((p) => ({ summary: "Moved to Amex", actions: [upd(itemRef(p, "Costco"), { account_ref: acctRef(p, "Wallet") })] }));
    const r = await edit("the Costco one was cash", [costco.id]);
    expect(r.res).toMatchObject({ applied: true, needsConfirmation: false, token: null, summary: "Moved to Amex", results: [{ ok: true }] });
    expect((await row(costco.id)).accountId).toBe("acc-cash");
  });

  it("still asks when Claude asks a question, when anything was dropped, or for more than one delete", async () => {
    const a = await seed({ payee: "Costco", total: 200_000 });
    const b = await seed({ payee: "Target", total: 40_000 });
    claudeAnswers(
      (p) => ({ summary: "x", actions: [upd(itemRef(p, "Costco"), { memo: "m" }), { type: "clarify", question: "Also Target?" }] }),
      (p) => ({ summary: "x", actions: [upd(itemRef(p, "Costco"), { memo: "m" }), upd("i42", { memo: "n" })] }),
      (p) => ({ summary: "x", actions: [{ type: "delete_intent", intent_ref: itemRef(p, "Costco") }, { type: "delete_intent", intent_ref: itemRef(p, "Target") }] }),
    );
    for (const text of ["memo m", "memo m and n", "delete these"]) {
      const r = await edit(text, text === "delete these" ? [a.id, b.id] : []);
      expect(r.res).toMatchObject({ applied: false, needsConfirmation: true });
      expect(r.res?.token).toEqual(expect.any(String));
    }
    expect((await row(a.id)).status).toBe("pending");
    expect((await row(b.id)).status).toBe("pending");
    expect((await row(a.id)).memo).toBeNull();
  });
});

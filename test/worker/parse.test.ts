// WP4: POST /api/intents/parse end to end with a canned Claude response (§9, §13 "Parse").
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn } from "../../src/shared/dates";
import { deleteSecrets, putSecret } from "../../src/worker/auth/secrets";
import { updateSettings } from "../../src/worker/auth/settings";
import { getAccounts, getSelectableCategories } from "../../src/worker/ynab/cache";
import { createYnabClientForToken } from "../../src/worker/ynab/client";
import { syncPlan } from "../../src/worker/ynab/sync";
import { PLAN_ID, seedPlan } from "../fixtures/ynab/plan";
import { apiError, FakeAnthropic, refusal, structured } from "../msw/anthropic";
import { FakeYnab } from "../msw/ynab";
import { call, db, envWith, seedSession, seedUser, uid } from "./wp2-helpers";

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => {
  network.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => network.disable());

const today = todayIn("UTC");
const E = envWith({ ALLOWED_USER_IDS: "*" });
let user = "";
let cookie = "";
let claude: FakeAnthropic;
let ref: { cat: (id: string) => string; acct: (id: string) => string };

beforeEach(async () => {
  user = uid("parse");
  await seedUser(user);
  cookie = (await seedSession(user)).cookie;
  await updateSettings(db(), user, { planId: PLAN_ID, timezone: "UTC", aiDataConsent: true, defaultAccountId: "acc-checking" });
  await putSecret(env, db(), user, "anthropic", "sk-ant-test-key");
  const ynab = new FakeYnab(seedPlan(today));
  claude = new FakeAnthropic();
  network.use(...ynab.handlers(), ...claude.handlers());
  await syncPlan(env, db(), createYnabClientForToken("tok"), user, PLAN_ID);
  // refs are assigned in cache order (§9.1)
  const cats = await getSelectableCategories(db(), user, PLAN_ID);
  const accts = await getAccounts(db(), user, PLAN_ID);
  ref = {
    cat: (id) => `c${cats.findIndex((c) => c.id === id) + 1}`,
    acct: (id) => `a${accts.findIndex((a) => a.id === id) + 1}`,
  };
});

const parse = (text: string) => call(E, "POST", "/api/intents/parse", { cookie, body: { text, inputMode: "typed" } });
const line = (o: Record<string, unknown>) => ({ description: "item", category_ref: null, category_confidence: "high", amount: null, amount_is_estimate: false, ...o });
const ptxn = (o: Record<string, unknown>) => ({
  payee: "Costco", merchant_kind: "in_person", direction: "outflow", date: today, account_ref: null,
  total_amount: 200, total_is_approximate: true, memo: null, lines: [], ...o,
});

describe("POST /api/intents/parse", () => {
  it("canned Claude response → drafts (payee id, category, last account for payee)", async () => {
    claude.reply(structured({ status: "ok", clarification_question: null, transactions: [
      ptxn({ lines: [line({ description: "groceries", category_ref: ref.cat("c-groceries") })] }),
    ] }));
    const res = await parse("Costco about 200 groceries");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok", question: null, warnings: [],
      drafts: [{
        payee: "Costco", payeeId: "p-costco", merchantKind: "in_person", direction: "outflow", date: today,
        accountId: "acc-visa", accountExplicit: false,              // Costco's last account (lastAccountForPayee)
        totalAmount: 200_000, approximate: true, memo: null,
        lines: [{ description: "groceries", categoryId: "c-groceries", amount: 200_000, approximate: true, confidence: "high" }],
      }],
    });

    // request policy (§9.1)
    expect(claude.requests).toHaveLength(1);
    const body = claude.requests[0]!.body;
    expect(body.max_tokens).toBe(8000);
    expect(body.output_config?.effort).toBe("low");
    const system = body.system as { type: string; text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system.some((b) => "cache_control" in b)).toBe(false);
    expect(system[0]?.text).toMatch(/^You convert a short note/);
    expect(system[1]?.text).toContain(`${ref.cat("c-groceries")} | Everyday > Groceries`);
    expect(system[1]?.text).toContain("PAYEES (frequent, for spelling): ");
    expect(system.map((b) => b.text).join("")).not.toContain(today);   // date only in the user turn
    expect(body.messages[0]?.content).toBe(`TODAY: ${today} (${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${today}T12:00:00Z`))}). Timezone: UTC. Currency: USD.\nNOTE: """Costco about 200 groceries"""`);
  });

  it("explicit account ref, Amazon lines, new payee warning, default account fallback", async () => {
    claude.reply(structured({ status: "ok", clarification_question: null, transactions: [
      ptxn({ payee: "Amazon", merchant_kind: "amazon", account_ref: ref.acct("acc-visa"), total_amount: 85, lines: [
        line({ description: "phone case", category_ref: ref.cat("c-dining"), amount: 20 }),
        line({ description: "book", category_ref: "c999", amount: 15 }),
      ] }),
      ptxn({ payee: "Brand New Bakery", total_amount: 7.5, total_is_approximate: false, date: addDays(today, 3),
        lines: [line({ description: "bread", category_ref: ref.cat("c-groceries") })] }),
    ] }));
    const res = await parse("amazon 85 on visa ... and bread");
    const body = await res.json<{ drafts: Record<string, unknown>[]; warnings: string[] }>();
    expect(res.status).toBe(200);
    expect(body.drafts[0]).toMatchObject({ payee: "Amazon", payeeId: "p-amazon", accountId: "acc-visa", accountExplicit: true, totalAmount: 85_000 });
    expect(body.drafts[0]?.lines).toEqual([
      { description: "phone case", categoryId: "c-dining", amount: 20_000, approximate: false, confidence: "high" },
      { description: "book", categoryId: null, amount: 15_000, approximate: false, confidence: "low" },
    ]);
    expect(body.drafts[1]).toMatchObject({ payee: "Brand New Bakery", payeeId: null, accountId: "acc-checking", accountExplicit: false, date: today, totalAmount: 7_500 });
    expect(body.warnings).toEqual([
      '#1: unknown category "c999" dropped',
      '#2: new payee "Brand New Bakery"',
      `#2: date ${addDays(today, 3)} is in the future; using today`,
    ]);
  });

  it("not_a_transaction and needs_clarification", async () => {
    claude.reply(structured({ status: "not_a_transaction", clarification_question: null, transactions: [] }));
    expect(await (await parse("hello there")).json()).toEqual({ status: "not_a_transaction", question: null, drafts: [], warnings: [] });
    claude.reply(structured({ status: "needs_clarification", clarification_question: "How much did you spend?", transactions: [] }));
    expect(await (await parse("bought stuff at costco")).json()).toEqual({ status: "needs_clarification", question: "How much did you spend?", drafts: [], warnings: [] });
  });

  it("refusal → 422 ai_refusal", async () => {
    claude.reply(refusal("I can't help with that."));
    const res = await parse("something odd");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "ai_refusal", message: "I can't help with that." } });
  });

  it("billing error → 409 anthropic_billing", async () => {
    claude.reply(apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."));
    const res = await parse("costco 20");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "anthropic_billing" } });
  });

  it("without consent → 409 ai_consent_required; without key → 409 anthropic_key_missing; no Claude call", async () => {
    await updateSettings(db(), user, { aiDataConsent: false });
    let res = await parse("costco 20");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "ai_consent_required" } });
    await updateSettings(db(), user, { aiDataConsent: true });
    await deleteSecrets(db(), user, ["anthropic"]);
    res = await parse("costco 20");
    expect(await res.json()).toMatchObject({ error: { code: "anthropic_key_missing" } });
    expect(claude.requests).toHaveLength(0);
  });

  it("validates the body and requires a plan", async () => {
    let res = await call(E, "POST", "/api/intents/parse", { cookie, body: { text: "  ", inputMode: "typed" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation" } });
    await updateSettings(db(), user, { planId: null });
    res = await parse("costco 20");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "no_plan_selected" } });
  });
});

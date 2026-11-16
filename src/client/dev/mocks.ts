// dev/mocks.ts — WP6 (DESIGN §12 WP6): MSW browser mocks so the SPA runs without the Worker.
// Loaded only when import.meta.env.DEV && VITE_MOCK_API (see main.tsx). Every response is parsed with the
// shared route table's response schema, so a fixture that drifts from the contract fails loudly.
// Log out / in: localStorage "mock:loggedOut" = "1" makes /api/me answer 401.
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupWorker } from "msw/browser";
import type { z } from "zod";
import { API, type ApiKey, type ErrorCode, ERROR_STATUS } from "../../shared/api";
import { addDays, todayIn } from "../../shared/dates";
import { normalizePayee } from "../../shared/payee";
import {
  DEFAULT_SETTINGS, SettingsPatch, type ActivityEntry, type Category, type InboxItem, type Intent, type IntentCreate,
  type IntentDraft, type Me, type ReviewItem, type Settings, type TxnView,
} from "../../shared/schemas";

const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
const now = Date.now();
const HOUR = 3_600_000;

const categories: Category[] = [
  { id: "c-groc", groupId: "g1", groupName: "Everyday", name: "Groceries" },
  { id: "c-dine", groupId: "g1", groupName: "Everyday", name: "Dining out" },
  { id: "c-house", groupId: "g1", groupName: "Everyday", name: "Household" },
  { id: "c-gas", groupId: "g2", groupName: "Transport", name: "Fuel" },
  { id: "c-elec", groupId: "g3", groupName: "Fun", name: "Electronics" },
  { id: "c-books", groupId: "g3", groupName: "Fun", name: "Books" },
  { id: "c-baby", groupId: "g4", groupName: "Kids", name: "Baby supplies" },
];
const accounts = [
  { id: "a-chk", name: "Checking", type: "checking", onBudget: true, closed: false, directImportLinked: true },
  { id: "a-cc", name: "Visa", type: "creditCard", onBudget: true, closed: false, directImportLinked: true },
  { id: "a-cash", name: "Wallet", type: "cash", onBudget: true, closed: false, directImportLinked: false },
];
const payees = [
  { id: "p-costco", name: "Costco" }, { id: "p-amzn", name: "Amazon" }, { id: "p-sbux", name: "Starbucks" },
  { id: "p-shell", name: "Shell" },
];

let settings: Settings = { ...DEFAULT_SETTINGS, planId: "plan-1", defaultAccountId: "a-cc", aiDataConsent: true, timezone: "America/New_York" };
let hasKey = true;
let sttAllowed = true;
let lastSyncAt: number | null = now - 2 * HOUR;
let seq = 100;

const txn = (id: string, payee: string, amount: number, date: string, extra: Partial<TxnView> = {}): TxnView => ({
  id, date, amount, payeeName: null, importPayeeName: payee, accountId: "a-cc", accountName: "Visa", categoryId: null,
  memo: null, approved: false, cleared: "cleared", isSplit: false, isTransfer: false, isImported: true, ...extra,
});

function makeIntent(id: string, payee: string, total: number, lines: { d: string; c: string; a: number }[], over: Partial<Intent> = {}): Intent {
  return {
    id, shortRef: id.toUpperCase().slice(-6).padStart(6, "X"), status: "pending", isStale: false, rawText: `${payee} about ${total / 1000}`,
    payee, payeeId: null, merchantKind: "in_person", direction: "outflow", date: today, accountId: null, accountExplicit: false,
    totalAmount: total, tolerance: 20_000, approximate: true, memo: null,
    placeholder: { txnId: `ph-${id}`, status: "created", amount: total - 10 },
    expiresOn: addDays(today, 14), createdAt: now - HOUR, resolvedAt: null,
    lines: lines.map((l, i) => ({
      id: `${id}-l${i}`, idx: i, description: l.d, categoryId: l.c, amount: l.a, tolerance: 2_000, approximate: true,
      status: "open", matchedTxnId: null,
    })),
    matchedTransactionIds: [], ...over,
  };
}

let intents: Intent[] = [
  makeIntent("i-costco", "Costco", 200_000, [{ d: "groceries", c: "c-groc", a: 200_000 }]),
  makeIntent("i-amzn", "Amazon", 85_000, [
    { d: "phone case", c: "c-elec", a: 20_000 }, { d: "book", c: "c-books", a: 15_000 }, { d: "diapers", c: "c-baby", a: 50_000 },
  ], { merchantKind: "amazon", status: "review" }),
  makeIntent("i-old", "Hardware store", 40_000, [{ d: "paint", c: "c-house", a: 40_000 }], {
    isStale: true, date: addDays(today, -20), expiresOn: addDays(today, -6), createdAt: now - 20 * 24 * HOUR,
  }),
];
let reviews: ReviewItem[] = [{
  id: "r-1", kind: "amazon_split", intentId: "i-amzn", transactionId: "t-amz1", createdAt: now - HOUR,
  summary: "Amazon charged $37.10 and $53.00. Which items are in each?",
  options: [{
    id: "o1", label: "Phone case + book on $37.10", intentId: "i-amzn", transactionId: "t-amz1", lineIds: ["i-amzn-l0", "i-amzn-l1"],
    allocation: [{ categoryId: "c-elec", amount: -21_200, memo: null }, { categoryId: "c-books", amount: -15_900, memo: null }], score: 0.92,
  }],
  transactions: [txn("t-amz1", "AMZN Mktp US*2K4L", -37_100, addDays(today, -1))],
  intents: [],
}];
let inbox: InboxItem[] = [
  { transaction: txn("t-1", "STARBUCKS #1234", -6_450, today), suggestion: { categoryId: "c-dine", confidence: "high", reason: "Coffee shop", source: "claude" }, possibleIntent: null },
  { transaction: txn("t-2", "SHELL OIL 5739", -48_200, addDays(today, -1)), suggestion: { categoryId: "c-gas", confidence: "medium", reason: "Fuel station", source: "history" }, possibleIntent: null },
  { transaction: txn("t-3", "COSTCO WHSE #0412", -212_470, addDays(today, -1)), suggestion: null, possibleIntent: { intentId: "i-costco", payee: "Costco", totalAmount: 200_000, date: today } },
  { transaction: txn("t-4", "SQ *FARMERS MKT", -18_000, addDays(today, -2)), suggestion: null, possibleIntent: null },
];
const activity: ActivityEntry[] = Array.from({ length: 70 }, (_, i) => ({
  id: `act-${i}`, at: now - i * 5 * HOUR, actor: (["user", "cron", "app"] as const)[i % 3] ?? "app",
  action: (["intent_created", "placeholder_created", "txn_categorized"] as const)[i % 3] ?? "intent_created",
  summary: ["Saved Costco ≈ $200.00", "Placeholder created in Visa", "Starbucks categorized as Dining out"][i % 3] ?? "",
  intentId: null, transactionId: null,
}));
reviews = reviews.map((r) => ({ ...r, intents: intents.filter((i) => i.id === r.intentId) }));

const me = (): Me => ({
  userId: "8f2c1d9e-0000-4000-8000-00000000c0de", isAdmin: true, authType: "pat", needsReauth: false, sttAllowed,
  hasAnthropicKey: hasKey, oauthAvailable: false, settings,
  plan: settings.planId ? { id: settings.planId, name: "Household budget", currency: { isoCode: "USD", decimalDigits: 2 } } : null,
  counts: {
    pending: intents.filter((i) => ["pending", "partial", "review"].includes(i.status)).length,
    stale: intents.filter((i) => i.isStale).length, review: reviews.length, inbox: inbox.length,
  },
  lastSyncError: null, lastSyncAt,
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = (key: ApiKey) => API[key].path;

function ok<K extends ApiKey>(key: K, body: z.input<(typeof API)[K]["res"]>): Response {
  const schema = API[key].res as z.ZodType;
  return HttpResponse.json(schema.parse(body) as JsonBodyType);
}
function fail(code: ErrorCode, message: string): Response {
  return HttpResponse.json({ error: { code, message } }, { status: ERROR_STATUS[code] });
}
const loggedOut = () => {
  try {
    return localStorage.getItem("mock:loggedOut") === "1";
  } catch {
    return false;
  }
};

function guessDraft(text: string): IntentDraft {
  const amount = /(\d+(?:[.,]\d{1,2})?)/.exec(text)?.[1];
  const at = /\bat\s+([A-Za-z][\w' &-]*?)(?:[,.]|\s+(?:for|on|yesterday|today)\b|$)/i.exec(text)?.[1]?.trim();
  const payee = at ?? (text.split(/\s+/).find((w) => /^[A-Z]/.test(w)) ?? "Unknown");
  const known = payees.find((p) => normalizePayee(p.name) === normalizePayee(payee));
  const cat = categories.find((c) => text.toLowerCase().includes(c.name.toLowerCase().split(" ")[0] ?? "")) ?? null;
  const total = amount ? Math.round(Number(amount.replace(",", ".")) * 1000) : null;
  return {
    payee, payeeId: known?.id ?? null, merchantKind: /amazon/i.test(text) ? "amazon" : "in_person", direction: "outflow",
    date: /yesterday/i.test(text) ? addDays(today, -1) : today, accountId: null, accountExplicit: false,
    totalAmount: total, approximate: /about|~|≈|around/i.test(text), memo: null,
    lines: [{ description: text.slice(0, 60), categoryId: cat?.id ?? null, amount: total, approximate: false, confidence: cat ? "medium" : "low" }],
  };
}

function createIntent(c: IntentCreate, rawText: string): Intent {
  const id = `i-${++seq}`;
  const acct = accounts.find((a) => a.id === (c.accountId ?? settings.defaultAccountId));
  const final = acct ? !acct.directImportLinked : false;
  return makeIntent(id, c.payee, c.totalAmount, c.lines.map((l) => ({ d: l.description, c: l.categoryId, a: l.amount ?? c.totalAmount })), {
    rawText, date: c.date, approximate: c.approximate, memo: c.memo, accountId: c.accountId, direction: c.direction,
    status: final ? "resolved" : "pending",
    placeholder: c.createPlaceholder && settings.createPlaceholders
      ? { txnId: `ph-${id}`, status: final ? "final" : "created", amount: c.totalAmount - (final ? 0 : 10) }
      : { txnId: null, status: "none", amount: null },
    createdAt: Date.now(),
  });
}

const findIntent = (id: string | readonly string[] | undefined) => intents.find((i) => i.id === id);

const handlers = [
  http.get(url("authConfig"), () => ok("authConfig", { oauthAvailable: false })),
  http.post(url("patLogin"), async () => {
    await delay(400);
    try { localStorage.removeItem("mock:loggedOut"); } catch { /* ignore */ }
    return ok("patLogin", me());
  }),
  http.post(url("logout"), () => {
    try { localStorage.setItem("mock:loggedOut", "1"); } catch { /* ignore */ }
    return ok("logout", { ok: true });
  }),
  http.get(url("me"), () => (loggedOut() ? fail("unauthenticated", "No session") : ok("me", me()))),
  http.get(url("getSettings"), () => ok("getSettings", settings)),
  http.patch(url("patchSettings"), async ({ request }) => {
    const p = SettingsPatch.safeParse(await request.json());
    if (!p.success) return fail("validation", p.error.message);
    settings = { ...settings, ...Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== undefined)) };
    return ok("patchSettings", settings);
  }),
  http.put(url("putAnthropicKey"), async () => {
    await delay(500);
    hasKey = true;
    return ok("putAnthropicKey", { ok: true });
  }),
  http.delete(url("delAnthropicKey"), () => {
    hasKey = false;
    return ok("delAnthropicKey", { ok: true });
  }),
  http.delete(url("deleteAccount"), () => {
    try { localStorage.setItem("mock:loggedOut", "1"); } catch { /* ignore */ }
    return ok("deleteAccount", { ok: true });
  }),
  http.get(url("plans"), async () => {
    await delay(300);
    return ok("plans", { plans: [{ id: "plan-1", name: "Household budget" }, { id: "plan-2", name: "Side business" }] });
  }),
  http.get(url("catalog"), () =>
    settings.planId
      ? ok("catalog", { planId: settings.planId, currency: { isoCode: "USD", decimalDigits: 2 }, categories, accounts, payees, recentCategoryIds: ["c-groc", "c-dine"] })
      : fail("no_plan_selected", "Pick a plan")),
  http.post(url("sync"), async () => {
    await delay(800);
    lastSyncAt = Date.now();
    return ok("sync", { ranAt: lastSyncAt, skipped: null, changedTransactions: 3, matched: 0, reviewsCreated: 0, stale: 1, inboxSuggested: 0, errors: [] });
  }),
  http.post(url("parse"), async ({ request }) => {
    await delay(900);
    const { text } = (await request.json()) as { text: string };
    if (/fail/i.test(text)) return fail("ai_unavailable", "Claude is overloaded");
    if (!/\d/.test(text)) return ok("parse", { status: "needs_clarification", question: "How much was it?", drafts: [], warnings: [] });
    const d = guessDraft(text);
    return ok("parse", { status: "ok", question: null, drafts: [d], warnings: d.payeeId ? [] : [`“${d.payee}” is a new payee`] });
  }),
  http.post(url("createIntents"), async ({ request }) => {
    await delay(600);
    const body = (await request.json()) as { intents: IntentCreate[]; rawText: string };
    const created = body.intents.map((c) => createIntent(c, body.rawText));
    intents = [...created, ...intents];
    return ok("createIntents", { intents: created, warnings: [] });
  }),
  http.get(url("listIntents"), ({ request }) => {
    const status = new URL(request.url).searchParams.get("status") ?? "open";
    const list = status === "stale"
      ? intents.filter((i) => i.isStale)
      : status === "open" ? intents.filter((i) => ["pending", "partial", "review"].includes(i.status))
        : intents.filter((i) => i.status === status);
    return ok("listIntents", { intents: list });
  }),
  http.get(url("candidates"), () => ok("candidates", { transactions: inbox.map((i) => i.transaction).slice(0, 3) })),
  http.get(url("getIntent"), ({ params }) => {
    const i = findIntent(params.id);
    return i ? ok("getIntent", { intent: i }) : fail("not_found", "No such intent");
  }),
  http.post(url("extendIntent"), async ({ params, request }) => {
    const i = findIntent(params.id);
    if (!i) return fail("not_found", "No such intent");
    const { days } = (await request.json()) as { days: number };
    i.expiresOn = addDays(i.expiresOn < today ? today : i.expiresOn, days);
    i.isStale = false;
    return ok("extendIntent", { intent: i });
  }),
  http.post(url("keepIntent"), ({ params }) => {
    const i = findIntent(params.id);
    if (!i) return fail("not_found", "No such intent");
    i.status = "resolved";
    i.isStale = false;
    i.placeholder = { ...i.placeholder, status: "final" };
    return ok("keepIntent", { intent: i });
  }),
  http.delete(url("cancelIntent"), ({ params }) => {
    const i = findIntent(params.id);
    if (!i) return fail("not_found", "No such intent");
    i.status = "cancelled";
    i.isStale = false;
    return ok("cancelIntent", { intent: i });
  }),
  http.post(url("linkIntent"), async ({ params, request }) => {
    const i = findIntent(params.id);
    if (!i) return fail("not_found", "No such intent");
    const { transactionId } = (await request.json()) as { transactionId: string };
    i.status = "resolved";
    i.isStale = false;
    i.matchedTransactionIds = [transactionId];
    inbox = inbox.filter((x) => x.transaction.id !== transactionId);
    return ok("linkIntent", { intent: i });
  }),
  http.get(url("listReviews"), () => ok("listReviews", { reviews })),
  http.post(url("resolveReview"), ({ params }) => {
    const r = reviews.find((x) => x.id === params.id);
    reviews = reviews.filter((x) => x.id !== params.id);
    const i = findIntent(r?.intentId ?? undefined);
    if (i) i.status = "partial";
    return ok("resolveReview", { ok: true });
  }),
  http.get(url("inbox"), () => ok("inbox", { items: inbox, lastSyncAt })),
  http.post(url("inboxSuggest"), async () => {
    await delay(1200);
    let n = 0;
    inbox = inbox.map((i) => (i.suggestion ? i : (n++, { ...i, suggestion: { categoryId: "c-groc", confidence: "low", reason: "Market", source: "claude" } })));
    return ok("inboxSuggest", { suggested: n });
  }),
  http.post(url("inboxApprove"), async ({ request }) => {
    const { items } = (await request.json()) as { items: { transactionId: string }[] };
    const ids = new Set(items.map((i) => i.transactionId));
    inbox = inbox.filter((i) => !ids.has(i.transaction.id));
    return ok("inboxApprove", { approved: ids.size, failed: [] });
  }),
  http.post(url("inboxDismiss"), async ({ request }) => {
    const { transactionIds } = (await request.json()) as { transactionIds: string[] };
    inbox = inbox.filter((i) => !transactionIds.includes(i.transaction.id));
    return ok("inboxDismiss", { ok: true });
  }),
  http.post(url("stt"), async () => {
    await delay(700);
    return ok("stt", { text: "about 40 at Shell for fuel" });
  }),
  http.get(url("activity"), ({ request }) => {
    const before = Number(new URL(request.url).searchParams.get("before") ?? Infinity);
    const page = activity.filter((a) => a.at < before).slice(0, 25);
    const more = activity.filter((a) => a.at < before).length > page.length;
    return ok("activity", { entries: page, nextCursor: more ? (page[page.length - 1]?.at ?? null) : null });
  }),
  http.get(url("adminUsers"), () =>
    ok("adminUsers", { users: [{ userId: me().userId, isAdmin: true, sttAllowed, authType: "pat", createdAt: now - 40 * 24 * HOUR, lastSeenAt: now }] })),
  http.patch(url("adminPatchUser"), async ({ request }) => {
    const { sttAllowed: v } = (await request.json()) as { sttAllowed: boolean };
    sttAllowed = v;
    return ok("adminPatchUser", { userId: me().userId, isAdmin: true, sttAllowed, authType: "pat", createdAt: now - 40 * 24 * HOUR, lastSeenAt: now });
  }),
];

export async function startMocks(): Promise<void> {
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledFrame: "bypass", quiet: false });
  console.info("[mocks] MSW browser mocks active (VITE_MOCK_API)");
}

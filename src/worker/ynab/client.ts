// ynab/client.ts — WP3 (DESIGN §8.3, D4, §10.11).
// YnabClient over the official `ynab@5` SDK. Every SDK class gets a Configuration whose `fetchApi` is our
// `backoffFetch`: it retries 429/503 and turns every other non-2xx into a YnabApiError (with the HTTP status,
// which the SDK's own "throw the JSON body" path would lose). SDK models are converted to the §8.3 types here,
// so SDK churn stays inside this file.
import { eq } from "drizzle-orm";
import {
  AccountsApi,
  CategoriesApi,
  Configuration,
  PayeesApi,
  PlansApi,
  TransactionsApi,
  UserApi,
  type AccountBase,
  type CategoryBase,
  type CategoryGroup,
  type NewTransaction,
  type Payee as SdkPayee,
  type SaveTransactionWithIdOrImportId,
  type SubTransactionBase,
  type TransactionDetail,
  type TransactionFlagColor,
  type TransactionSummaryBase,
} from "ynab";
import type { CurrencyFormat } from "../../shared/schemas";
import { markNeedsReauth, getYnabAccessToken } from "../auth/ynabToken";
import { syncState } from "../db/schema";
import type { DB } from "../env";
import { AppError } from "../lib/errors";
import { asYnabApiError, isYnabErrorBody, RATE_LIMIT_COOLDOWN_MS, toAppError, YnabApiError } from "./errors";
import type {
  CachedAccount, CachedCategory, CachedCategoryGroup, CachedPayee, NewTxn, PlanDelta, TxnUpdate, YnabTxn,
} from "./types";

export interface YnabClient {
  getUserId(): Promise<string>;
  listPlans(): Promise<{ id: string; name: string }[]>;
  getPlanSettings(planId: string): Promise<CurrencyFormat>;
  getCategories(planId: string, k?: number): Promise<{ groups: CachedCategoryGroup[]; items: CachedCategory[]; serverKnowledge: number }>;
  getAccounts(planId: string, k?: number): Promise<{ items: CachedAccount[]; serverKnowledge: number }>;
  getPayees(planId: string, k?: number): Promise<{ items: CachedPayee[]; serverKnowledge: number }>;
  getTransactionsSince(planId: string, sinceDate: string, k?: number): Promise<{ items: YnabTxn[]; serverKnowledge: number }>;
  getPlanDelta(planId: string, k: number): Promise<PlanDelta>;
  getTransaction(planId: string, id: string): Promise<YnabTxn | null>;   // null on 404
  createTransaction(planId: string, txn: NewTxn): Promise<YnabTxn>;
  /** The only update method. Bulk PATCH /transactions; SaveTransactionWithIdOrImportId accepts
   *  `subtransactions`, so split conversion goes through here too. If spike S2 shows PATCH ignores
   *  subtransactions, the implementation sends split updates as individual PUTs internally;
   *  the signature does not change. Updating an existing split returns a YNAB error (SDK docs). */
  updateTransactions(planId: string, updates: TxnUpdate[]): Promise<YnabTxn[]>;
  deleteTransaction(planId: string, id: string): Promise<void>;          // 404 = success
}
export type RequestKind = "interactive" | "background";

// ── backoff (§10.11) ────────────────────────────────────────────────────────

/** Indirection so tests can skip real waiting (`vi.spyOn(backoff, "sleep")`). */
export const backoff = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  /** ±25 % jitter. */
  jitter: (ms: number): number => Math.round(ms * (0.75 + Math.random() * 0.5)),
};

/** Delays before each retry on 429: background 1 s then 4 s; interactive only 1 s (fails fast). */
const RETRY_429: Record<RequestKind, number[]> = { background: [1000, 4000], interactive: [1000] };
const RETRY_503_MS = 1000; // 503: retry once

async function errorFromResponse(res: Response): Promise<YnabApiError> {
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON (e.g. an HTML 503 page) */
  }
  if (isYnabErrorBody(parsed)) return new YnabApiError(res.status, parsed.error);
  return new YnabApiError(res.status, { id: String(res.status), name: "http_error", detail: text.slice(0, 200) });
}

/** fetch with the §10.11 retry policy. Non-2xx after retries → throws YnabApiError. */
export function backoffFetch(kind: RequestKind, baseFetch: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const delays429 = RETRY_429[kind];
    let tries429 = 0;
    let retried503 = false;
    for (;;) {
      const res = await baseFetch(input, init);
      if (res.ok) return res;
      if (res.status === 429 && tries429 < delays429.length) {
        await res.body?.cancel();
        await backoff.sleep(backoff.jitter(delays429[tries429] ?? 1000));
        tries429++;
        continue;
      }
      if (res.status === 503 && !retried503) {
        await res.body?.cancel();
        await backoff.sleep(backoff.jitter(RETRY_503_MS));
        retried503 = true;
        continue;
      }
      throw await errorFromResponse(res);
    }
  };
}

// ── conversions (SDK models → §8.3 types) ───────────────────────────────────

const flag = (f: TransactionFlagColor | null | undefined): string | null => (f ? f : null);

export function detailToTxn(planId: string, d: TransactionDetail): YnabTxn {
  return {
    id: d.id,
    planId,
    date: d.date,
    amount: d.amount,
    payeeId: d.payee_id ?? null,
    payeeName: d.payee_name ?? null,
    importPayeeName: d.import_payee_name ?? null,
    importPayeeNameOriginal: d.import_payee_name_original ?? null,
    accountId: d.account_id,
    categoryId: d.category_id ?? null,
    memo: d.memo ?? null,
    cleared: d.cleared,
    approved: d.approved,
    flagColor: flag(d.flag_color),
    importId: d.import_id ?? null,
    matchedTransactionId: d.matched_transaction_id ?? null,
    transferAccountId: d.transfer_account_id ?? null,
    isSplit: (d.subtransactions ?? []).some((s) => !s.deleted),
    deleted: d.deleted,
  };
}

/** TransactionSummary (plan delta) has no payee_name: filled from `payeeNames` when known, else null
 *  (syncPlan fills the rest from the payee cache). isSplit from the delta's subtransactions. */
export function summaryToTxn(planId: string, s: TransactionSummaryBase, payeeNames: Map<string, string>, splitParents: Set<string>): YnabTxn {
  return {
    id: s.id,
    planId,
    date: s.date,
    amount: s.amount,
    payeeId: s.payee_id ?? null,
    payeeName: s.payee_id ? (payeeNames.get(s.payee_id) ?? null) : null,
    importPayeeName: s.import_payee_name ?? null,
    importPayeeNameOriginal: s.import_payee_name_original ?? null,
    accountId: s.account_id,
    categoryId: s.category_id ?? null,
    memo: s.memo ?? null,
    cleared: s.cleared,
    approved: s.approved,
    flagColor: flag(s.flag_color),
    importId: s.import_id ?? null,
    matchedTransactionId: s.matched_transaction_id ?? null,
    transferAccountId: s.transfer_account_id ?? null,
    isSplit: splitParents.has(s.id),
    deleted: s.deleted,
  };
}

export const toCachedGroup = (g: CategoryGroup): CachedCategoryGroup => ({ id: g.id, name: g.name, hidden: g.hidden, deleted: g.deleted });
export const toCachedCategory = (c: CategoryBase, sortIndex: number): CachedCategory => ({
  id: c.id, groupId: c.category_group_id, name: c.name, hidden: c.hidden, deleted: c.deleted, sortIndex,
});
export const toCachedAccount = (a: AccountBase): CachedAccount => ({
  id: a.id, name: a.name, type: a.type, onBudget: a.on_budget, closed: a.closed, deleted: a.deleted,
  directImportLinked: a.direct_import_linked ?? false,
});
export const toCachedPayee = (p: SdkPayee): CachedPayee => ({
  id: p.id, name: p.name, transferAccountId: p.transfer_account_id ?? null, deleted: p.deleted,
});

function splitParentsOf(subs: SubTransactionBase[] | undefined): Set<string> {
  return new Set((subs ?? []).filter((s) => !s.deleted).map((s) => s.transaction_id));
}

/** Parents with only deleted subtransactions in a delta: the split was removed. */
export function unsplitParentsOf(subs: SubTransactionBase[] | undefined): string[] {
  const live = splitParentsOf(subs);
  return [...new Set((subs ?? []).filter((s) => s.deleted && !live.has(s.transaction_id)).map((s) => s.transaction_id))];
}

const toSaveSubs = (subs: NonNullable<NewTxn["subtransactions"]>) =>
  subs.map((s) => ({ amount: s.amount, category_id: s.categoryId, memo: s.memo }));

function toNewTransaction(t: NewTxn): NewTransaction {
  const split = t.subtransactions !== undefined && t.subtransactions.length > 0;
  const out: NewTransaction = {
    account_id: t.accountId,
    date: t.date,
    amount: t.amount,
    category_id: split ? null : t.categoryId,
    memo: t.memo,
    cleared: "uncleared",            // never import_id, always uncleared (§8.3 NewTxn)
    approved: t.approved,
    flag_color: t.flagColor,
  };
  if (t.payeeId) out.payee_id = t.payeeId;
  else out.payee_name = t.payeeName;
  if (split && t.subtransactions) out.subtransactions = toSaveSubs(t.subtransactions);
  return out;
}

function toSaveTransaction(u: TxnUpdate): SaveTransactionWithIdOrImportId {
  const out: SaveTransactionWithIdOrImportId = { id: u.id };
  if (u.categoryId !== undefined) out.category_id = u.categoryId;
  if (u.memo !== undefined) out.memo = u.memo;
  if (u.approved !== undefined) out.approved = u.approved;
  if (u.flagColor !== undefined) out.flag_color = u.flagColor;
  if (u.amount !== undefined) out.amount = u.amount;
  if (u.date !== undefined) out.date = u.date;
  if (u.subtransactions !== undefined) {
    out.subtransactions = toSaveSubs(u.subtransactions);
    out.category_id = null;          // a split has no category of its own
  }
  return out;
}

// ── client ──────────────────────────────────────────────────────────────────

export interface ClientOptions {
  kind: RequestKind;
  /** Side effects of a YNAB error before it is rethrown as AppError (needs-reauth flag, rate-limit cooldown). */
  onYnabError?: (e: YnabApiError) => Promise<void>;
  /** Override the base fetch (tests). */
  fetch?: typeof fetch;
}

/** Builds a YnabClient for a bearer token. Errors surface as AppError (§8.3 toAppError). */
export function createYnabClientWith(token: string, opts: ClientOptions): YnabClient {
  const cfg = new Configuration({ accessToken: token, fetchApi: backoffFetch(opts.kind, opts.fetch) });
  const plans = new PlansApi(cfg);
  const txns = new TransactionsApi(cfg);
  const categories = new CategoriesApi(cfg);
  const accounts = new AccountsApi(cfg);
  const payees = new PayeesApi(cfg);
  const user = new UserApi(cfg);

  /** Runs an SDK call; maps YNAB errors to AppError. `notFound` (if given) is returned on 404. */
  async function call<T, N = never>(fn: () => Promise<T>, notFound?: () => N): Promise<T | N> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AppError) throw e;
      const ye = asYnabApiError(e);
      if (!ye) throw new AppError("ynab_error", "Could not reach YNAB", e);
      if (ye.status === 404 && notFound) return notFound();
      if (opts.onYnabError) {
        try {
          await opts.onYnabError(ye);
        } catch (sideEffectError) {
          console.error(JSON.stringify({ msg: "ynab_error_side_effect_failed", error: String(sideEffectError) }));
        }
      }
      throw toAppError(ye);
    }
  }

  return {
    async getUserId() {
      const r = await call(() => user.getUser());
      return r.data.user.id;
    },
    async listPlans() {
      const r = await call(() => plans.getPlans(false));
      return r.data.plans.map((p) => ({ id: p.id, name: p.name }));
    },
    async getPlanSettings(planId) {
      const r = await call(() => plans.getPlanSettingsById(planId));
      const cf = r.data.settings.currency_format;
      return { isoCode: cf?.iso_code ?? "USD", decimalDigits: cf?.decimal_digits ?? 2 };
    },
    async getCategories(planId, k) {
      const r = await call(() => categories.getCategories(planId, k));
      const groups: CachedCategoryGroup[] = [];
      const items: CachedCategory[] = [];
      r.data.category_groups.forEach((g, gi) => {
        groups.push(toCachedGroup(g));
        g.categories.forEach((c, ci) => items.push(toCachedCategory(c, gi * 1000 + ci)));
      });
      return { groups, items, serverKnowledge: r.data.server_knowledge };
    },
    async getAccounts(planId, k) {
      const r = await call(() => accounts.getAccounts(planId, k));
      return { items: r.data.accounts.map(toCachedAccount), serverKnowledge: r.data.server_knowledge };
    },
    async getPayees(planId, k) {
      const r = await call(() => payees.getPayees(planId, k));
      return { items: r.data.payees.map(toCachedPayee), serverKnowledge: r.data.server_knowledge };
    },
    async getTransactionsSince(planId, sinceDate, k) {
      const r = await call(() => txns.getTransactions(planId, sinceDate, undefined, undefined, k));
      return { items: r.data.transactions.map((t) => detailToTxn(planId, t)), serverKnowledge: r.data.server_knowledge };
    },
    async getPlanDelta(planId, k) {
      const r = await call(() => plans.getPlanById(planId, k));
      const p = r.data.plan;
      const payeeItems = (p.payees ?? []).map(toCachedPayee);
      const payeeNames = new Map(payeeItems.map((x) => [x.id, x.name]));
      const splitParents = splitParentsOf(p.subtransactions);
      return {
        serverKnowledge: r.data.server_knowledge,
        transactions: (p.transactions ?? []).map((t) => summaryToTxn(planId, t, payeeNames, splitParents)),
        categoryGroups: (p.category_groups ?? []).map(toCachedGroup),
        categories: (p.categories ?? []).map((c, i) => toCachedCategory(c, i)),
        accounts: (p.accounts ?? []).map(toCachedAccount),
        payees: payeeItems,
        unsplitTxnIds: unsplitParentsOf(p.subtransactions),
      };
    },
    async getTransaction(planId, id) {
      const r = await call(() => txns.getTransactionById(planId, id), () => null);
      return r === null ? null : detailToTxn(planId, r.data.transaction);
    },
    async createTransaction(planId, txn) {
      const r = await call(() => txns.createTransaction(planId, { transaction: toNewTransaction(txn) }));
      const created = r.data.transaction ?? r.data.transactions?.[0];
      if (!created) throw new AppError("ynab_error", "YNAB did not return the created transaction");
      return detailToTxn(planId, created);
    },
    async updateTransactions(planId, updates) {
      if (updates.length === 0) return [];
      // Spike S2 (open): bulk PATCH is assumed to accept `subtransactions` for converting a non-split txn.
      const r = await call(() => txns.updateTransactions(planId, { transactions: updates.map(toSaveTransaction) }));
      return (r.data.transactions ?? (r.data.transaction ? [r.data.transaction] : [])).map((t) => detailToTxn(planId, t));
    },
    async deleteTransaction(planId, id) {
      await call(() => txns.deleteTransaction(planId, id), () => null);
    },
  };
}

/** Token via getYnabAccessToken. `kind` only changes backoff: interactive fails fast on 429. */
export async function createYnabClient(env: Env, db: DB, userId: string, kind: RequestKind): Promise<YnabClient> {
  const token = await getYnabAccessToken(env, db, userId);
  return createYnabClientWith(token, {
    kind,
    onYnabError: async (e) => {
      if (e.status === 401) {
        await markNeedsReauth(db, userId);
      } else if (e.status === 429) {
        // The limit is per token, so every plan of this user cools down.
        await db.update(syncState).set({ rateLimitedUntil: Date.now() + RATE_LIMIT_COOLDOWN_MS }).where(eq(syncState.userId, userId));
      }
    },
  });
}

/** For login (no user row yet). */
export function createYnabClientForToken(token: string): YnabClient {
  return createYnabClientWith(token, { kind: "interactive" });
}

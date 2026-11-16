// WP5 worker-test helpers (not a test file): D1 seeding and an in-memory fake YnabClient.
// The engine is tested against this fake (and real D1), not against WP3's HTTP client.
import { env } from "cloudflare:workers";
import { DEFAULT_SETTINGS, type Settings } from "../../src/shared/schemas";
import { getDb } from "../../src/worker/db/client";
import {
  intentLines, intents, syncState, users, ynabAccounts, ynabCategories, ynabCategoryGroups, ynabTransactions,
} from "../../src/worker/db/schema";
import type { DB } from "../../src/worker/env";
import type { YnabClient } from "../../src/worker/ynab/client";
import type { NewTxn, TxnUpdate, YnabTxn } from "../../src/worker/ynab/types";

export const PLAN = "plan-1";
export const db = (): DB => getDb(env);
let seq = 0;
export const uid = (p = "u") => `${p}-${Date.now().toString(36)}-${++seq}`;

export const settingsFor = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, planId: PLAN, timezone: "UTC", ...over });

export async function seedUser(userId: string): Promise<void> {
  const now = Date.now();
  await db().insert(users).values({ id: userId, authType: "pat", sttAllowed: false, needsReauth: false, tokenRefreshLockUntil: null, createdAt: now, lastSeenAt: now });
  await db().insert(syncState).values({ userId, planId: PLAN, planName: "Test plan", currencyIso: "USD", currencyDecimals: 2, serverKnowledge: 1 });
  await db().insert(ynabCategoryGroups).values([
    { userId, planId: PLAN, id: `${userId}-g-int`, name: "Internal Master Category" },
    { userId, planId: PLAN, id: `${userId}-g-1`, name: "Everyday" },
  ]);
  await db().insert(ynabCategories).values([
    { userId, planId: PLAN, id: "cat-uncat", groupId: `${userId}-g-int`, name: "Uncategorized" },
    ...["groceries", "fuel", "home", "kids", "books", "toys", "lamp", "household"].map((n, k) => ({
      userId, planId: PLAN, id: `cat-${n}`, groupId: `${userId}-g-1`, name: n[0]!.toUpperCase() + n.slice(1), sortIndex: k,
    })),
  ]);
  await db().insert(ynabAccounts).values([
    { userId, planId: PLAN, id: "acc-card", name: "Visa", type: "creditCard", onBudget: true, directImportLinked: true },
    { userId, planId: PLAN, id: "acc-cash", name: "Wallet", type: "cash", onBudget: true, directImportLinked: false },
  ]);
}

export interface IntentSeed {
  id?: string; payee: string; date?: string; total: number; approximate?: boolean; merchantKind?: "amazon" | "online" | "in_person" | "other";
  direction?: "outflow" | "inflow"; accountId?: string | null; accountExplicit?: boolean; status?: "pending" | "partial" | "review" | "resolved" | "cancelled";
  placeholderTxnId?: string | null; placeholderStatus?: "none" | "created" | "auto_matched" | "deleted" | "missing" | "failed" | "final";
  placeholderAmount?: number | null; expiresOn?: string; shortRef?: string; memo?: string | null; resolvedAt?: number | null; updatedAt?: number;
  lines?: { id?: string; description: string; categoryId: string; amount: number; approximate?: boolean; status?: "open" | "matched" }[];
}

const tol = (a: number, approx: boolean) => (approx ? Math.max(1000, Math.round(0.05 * a)) : Math.max(500, Math.round(0.01 * a)));

/** Inserts an intent with lines; returns ids. Tolerances come from the real computeTolerance via the caller when it matters. */
export async function seedIntent(userId: string, s: IntentSeed, tolerance?: (a: number, approx: boolean) => number): Promise<{ id: string; shortRef: string; lineIds: string[] }> {
  const id = s.id ?? uid("int");
  const shortRef = s.shortRef ?? `R${(++seq).toString(36).toUpperCase().padStart(5, "0")}`.slice(0, 6);
  const now = Date.now();
  const approx = s.approximate ?? true;
  const t = tolerance ?? tol;
  await db().insert(intents).values({
    id, userId, planId: PLAN, shortRef, status: s.status ?? "pending", rawText: s.payee, inputMode: "typed",
    payee: s.payee, payeeId: null, merchantKind: s.merchantKind ?? "in_person", direction: s.direction ?? "outflow",
    intentDate: s.date ?? "2026-11-10", accountId: s.accountId === undefined ? "acc-card" : s.accountId, accountExplicit: s.accountExplicit ?? false,
    totalAmount: s.total, tolerance: t(s.total, approx), approximate: approx, memo: s.memo ?? null,
    placeholderTxnId: s.placeholderTxnId ?? null, placeholderStatus: s.placeholderStatus ?? "none", placeholderAmount: s.placeholderAmount ?? null,
    expiresOn: s.expiresOn ?? "2026-12-31", createdAt: now, updatedAt: s.updatedAt ?? now, resolvedAt: s.resolvedAt ?? null,
  });
  const lines = (s.lines ?? [{ description: "stuff", categoryId: "cat-groceries", amount: s.total, approximate: approx }]).map((l, idx) => ({
    id: l.id ?? uid("ln"), intentId: id, idx, description: l.description, categoryId: l.categoryId, amount: l.amount,
    tolerance: t(l.amount, l.approximate ?? approx), approximate: l.approximate ?? approx, status: l.status ?? ("open" as const), matchedTxnId: null,
  }));
  await db().insert(intentLines).values(lines);
  return { id, shortRef, lineIds: lines.map((l) => l.id) };
}

export function mkTxn(over: Partial<YnabTxn> & { id: string }): YnabTxn {
  return {
    planId: PLAN, date: "2026-11-11", amount: -10000, payeeId: null, payeeName: null, importPayeeName: null, importPayeeNameOriginal: null,
    accountId: "acc-card", categoryId: null, memo: null, cleared: "cleared", approved: false, flagColor: null,
    importId: `YNAB:${over.id}`, matchedTransactionId: null, transferAccountId: null, isSplit: false, deleted: false, ...over,
  };
}

/** Writes txns into the cache (as a sync would). */
export async function cacheTxns(userId: string, txns: YnabTxn[]): Promise<void> {
  const now = Date.now();
  for (const t of txns) {
    const { planId: _p, ...rest } = t;
    await db().insert(ynabTransactions).values({ userId, planId: PLAN, ...rest, updatedAt: now })
      .onConflictDoUpdate({ target: [ynabTransactions.userId, ynabTransactions.id], set: { ...rest, updatedAt: now } });
  }
}

export interface Call { method: string; args: unknown[] }
type ErrFactory = () => Error;

/** In-memory YNAB. Mirrors the YnabClient contract closely enough for the engine. */
export class FakeYnab implements YnabClient {
  txns = new Map<string, YnabTxn>();
  calls: Call[] = [];
  private failures: { method: string; make: ErrFactory; times: number }[] = [];
  private n = 0;

  seed(...ts: YnabTxn[]): this {
    for (const t of ts) this.txns.set(t.id, { ...t });
    return this;
  }
  failNext(method: string, make: ErrFactory, times = 1): void {
    this.failures.push({ method, make, times });
  }
  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
  private enter(method: string, args: unknown[]): void {
    this.calls.push({ method, args: structuredClone(args) });
    const f = this.failures.find((x) => x.method === method && x.times > 0);
    if (f) {
      f.times--;
      throw f.make();
    }
  }
  async getUserId() { return "ynab-user"; }
  async listPlans() { return [{ id: PLAN, name: "Test plan" }]; }
  async getPlanSettings() { return { isoCode: "USD", decimalDigits: 2 }; }
  async getCategories(): Promise<never> { throw new Error("FakeYnab.getCategories not used"); }
  async getAccounts(): Promise<never> { throw new Error("FakeYnab.getAccounts not used"); }
  async getPayees(): Promise<never> { throw new Error("FakeYnab.getPayees not used"); }
  async getTransactionsSince(): Promise<never> { throw new Error("FakeYnab.getTransactionsSince not used"); }
  async getPlanDelta(): Promise<never> { throw new Error("FakeYnab.getPlanDelta not used"); }
  async getTransaction(planId: string, id: string) {
    this.enter("getTransaction", [planId, id]);
    const t = this.txns.get(id);
    return t ? { ...t } : null;
  }
  async createTransaction(planId: string, n: NewTxn) {
    this.enter("createTransaction", [planId, n]);
    const id = `ph-${++this.n}-${Date.now().toString(36)}`;
    const t: YnabTxn = {
      id, planId, date: n.date, amount: n.amount, payeeId: n.payeeId, payeeName: n.payeeName, importPayeeName: null, importPayeeNameOriginal: null,
      accountId: n.accountId, categoryId: n.subtransactions?.length ? null : n.categoryId, memo: n.memo, cleared: "uncleared",
      approved: n.approved, flagColor: n.flagColor, importId: null, matchedTransactionId: null, transferAccountId: null,
      isSplit: !!n.subtransactions?.length, deleted: false,
    };
    this.txns.set(id, t);
    return { ...t };
  }
  async updateTransactions(planId: string, updates: TxnUpdate[]) {
    this.enter("updateTransactions", [planId, updates]);
    return updates.map((u) => {
      const t = this.txns.get(u.id);
      if (!t) throw new Error(`FakeYnab: no txn ${u.id}`);
      if (u.memo !== undefined) t.memo = u.memo;
      if (u.approved !== undefined) t.approved = u.approved;
      if (u.flagColor !== undefined) t.flagColor = u.flagColor;
      if (u.amount !== undefined) t.amount = u.amount;
      if (u.date !== undefined) t.date = u.date;
      if (u.categoryId !== undefined) t.categoryId = u.categoryId;
      if (u.subtransactions?.length) {
        t.isSplit = true;
        t.categoryId = null;
      }
      return { ...t };
    });
  }
  async deleteTransaction(planId: string, id: string) {
    this.enter("deleteTransaction", [planId, id]);
    const t = this.txns.get(id);
    if (t) t.deleted = true;
  }
}

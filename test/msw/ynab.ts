// FakeYnab (WP3): an in-memory api.ynab.com for msw@3 (+ @msw/cloudflare in the Workers pool).
// Every entity carries the server knowledge at which it last changed, so `last_knowledge_of_server`
// deltas behave like YNAB's. Mutate with the helpers (they bump knowledge); inspect `requests`.
// Other packages (WP5 end-to-end tests) can reuse it:  network.use(...fake.handlers())
import { http, HttpResponse, type HttpHandler, type HttpResponseResolver } from "msw";
import type { RawAccount, RawCategory, RawGroup, RawPayee, RawSub, RawTxn, SeedPlan } from "../fixtures/ynab/plan";

export const YNAB_BASE = "https://api.ynab.com/v1";

type K<T> = T & { k: number };
interface PlanState {
  id: string; name: string; currency: { iso_code: string; decimal_digits: number };
  groups: Map<string, K<RawGroup>>; categories: Map<string, K<RawCategory>>; accounts: Map<string, K<RawAccount>>;
  payees: Map<string, K<RawPayee>>; transactions: Map<string, K<RawTxn>>; subtransactions: Map<string, K<RawSub>>;
}
export interface RecordedRequest { method: string; path: string; search: URLSearchParams; body: unknown; auth: string | null }
interface Failure { method: string; path: RegExp; status: number; body: unknown; times: number }

const CURRENCY_EXTRA = { example_format: "123,456.78", decimal_separator: ".", symbol_first: true, group_separator: ",", currency_symbol: "$", display_symbol: true };

export class FakeYnab {
  knowledge = 1000;
  userId = "ynab-user-1";
  plans = new Map<string, PlanState>();
  requests: RecordedRequest[] = [];
  private failures: Failure[] = [];
  private nextId = 1;

  constructor(seed?: SeedPlan) {
    if (seed) this.addPlan(seed);
  }

  addPlan(seed: SeedPlan): void {
    const k = this.knowledge;
    const map = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, { ...x, k }]));
    this.plans.set(seed.id, {
      id: seed.id, name: seed.name, currency: seed.currency,
      groups: map(seed.groups), categories: map(seed.categories), accounts: map(seed.accounts),
      payees: map(seed.payees), transactions: map(seed.transactions), subtransactions: map(seed.subtransactions),
    });
  }

  plan(planId: string): PlanState {
    const p = this.plans.get(planId);
    if (!p) throw new Error(`FakeYnab: unknown plan ${planId}`);
    return p;
  }

  // ── mutators (each bumps server knowledge) ──
  bump(): number {
    return ++this.knowledge;
  }
  putTxn(planId: string, t: RawTxn): void {
    this.plan(planId).transactions.set(t.id, { ...t, k: this.bump() });
  }
  updateTxn(planId: string, id: string, patch: Partial<RawTxn>): void {
    const p = this.plan(planId);
    const cur = p.transactions.get(id);
    if (!cur) throw new Error(`FakeYnab: unknown txn ${id}`);
    p.transactions.set(id, { ...cur, ...patch, k: this.bump() });
  }
  putSub(planId: string, s: RawSub): void {
    this.plan(planId).subtransactions.set(s.id, { ...s, k: this.bump() });
  }
  putPayee(planId: string, x: RawPayee): void {
    this.plan(planId).payees.set(x.id, { ...x, k: this.bump() });
  }
  putCategory(planId: string, x: RawCategory): void {
    this.plan(planId).categories.set(x.id, { ...x, k: this.bump() });
  }
  putGroup(planId: string, x: RawGroup): void {
    this.plan(planId).groups.set(x.id, { ...x, k: this.bump() });
  }
  putAccount(planId: string, x: RawAccount): void {
    this.plan(planId).accounts.set(x.id, { ...x, k: this.bump() });
  }

  /** The next `times` requests matching method + path regex answer `status` with a YNAB error body (or `body`). */
  failNext(method: string, path: RegExp, status: number, opts: { id?: string; body?: unknown; times?: number } = {}): void {
    const body = opts.body ?? { error: { id: opts.id ?? String(status), name: `error_${status}`, detail: `Injected ${status}` } };
    this.failures.push({ method: method.toUpperCase(), path, status, body, times: opts.times ?? 1 });
  }
  requestsTo(method: string, path: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method.toUpperCase() && path.test(r.path));
  }

  // ── JSON views ──
  private strip<T extends object>(x: K<T>): T {
    const { k: _k, ...rest } = x;
    return rest as unknown as T;
  }
  private detail(p: PlanState, t: K<RawTxn>) {
    const subs = [...p.subtransactions.values()].filter((s) => s.transaction_id === t.id).map((s) => this.strip(s));
    return {
      ...this.strip(t),
      account_name: p.accounts.get(t.account_id)?.name ?? "?",
      payee_name: t.payee_id ? (p.payees.get(t.payee_id)?.name ?? null) : null,
      category_name: t.category_id ? (p.categories.get(t.category_id)?.name ?? null) : null,
      subtransactions: subs,
    };
  }
  private since<T>(m: Map<string, K<T>>, k: number | null): K<T>[] {
    return [...m.values()].filter((x) => k === null || x.k > k);
  }

  handlers(): HttpHandler[] {
    const wrap = (method: string, fn: (req: unknown, params: Record<string, string>, url: URL, body: unknown) => Response | Promise<Response>): HttpResponseResolver =>
      async ({ request, params }) => {
        const url = new URL(request.url);
        const body: unknown = request.method === "GET" || request.method === "DELETE" ? null : await request.clone().json().catch(() => null);
        this.requests.push({ method, path: url.pathname.replace(/^\/v1/, ""), search: url.searchParams, body, auth: request.headers.get("authorization") });
        const path = url.pathname.replace(/^\/v1/, "");
        const f = this.failures.find((x) => x.method === method && x.path.test(path));
        if (f) {
          f.times--;
          if (f.times <= 0) this.failures.splice(this.failures.indexOf(f), 1);
          return HttpResponse.json(f.body as Record<string, unknown>, { status: f.status });
        }
        const flat: Record<string, string> = {};
        for (const [key, v] of Object.entries(params)) if (typeof v === "string") flat[key] = v;
        return fn(request, flat, url, body);
      };
    const notFound = () => HttpResponse.json({ error: { id: "404.2", name: "resource_not_found", detail: "Resource not found" } }, { status: 404 });
    const kParam = (url: URL) => {
      const v = url.searchParams.get("last_knowledge_of_server");
      return v === null ? null : Number(v);
    };
    const B = YNAB_BASE;
    return [
      http.get(`${B}/user`, wrap("GET", () => HttpResponse.json({ data: { user: { id: this.userId } } }))),
      http.get(`${B}/plans`, wrap("GET", () => HttpResponse.json({
        data: { plans: [...this.plans.values()].map((p) => ({ id: p.id, name: p.name, last_modified_on: "2026-11-01T00:00:00Z" })), default_plan: null },
      }))),
      http.get(`${B}/plans/:planId/settings`, wrap("GET", (_r, { planId }) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        return HttpResponse.json({ data: { settings: { date_format: { format: "YYYY-MM-DD" }, currency_format: { ...CURRENCY_EXTRA, ...p.currency } } } });
      })),
      http.get(`${B}/plans/:planId/categories`, wrap("GET", (_r, { planId }, url) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        const k = kParam(url);
        const cats = this.since(p.categories, k);
        const groups = [...p.groups.values()].filter((g) => k === null || g.k > k || cats.some((c) => c.category_group_id === g.id));
        return HttpResponse.json({ data: {
          category_groups: groups.map((g) => ({ ...this.strip(g), internal: g.internal ?? false,
            categories: cats.filter((c) => c.category_group_id === g.id).map((c) => ({ ...this.strip(c), internal: c.internal ?? false })) })),
          server_knowledge: this.knowledge,
        } });
      })),
      http.get(`${B}/plans/:planId/accounts`, wrap("GET", (_r, { planId }, url) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        return HttpResponse.json({ data: { accounts: this.since(p.accounts, kParam(url)).map((a) => this.strip(a)), server_knowledge: this.knowledge } });
      })),
      http.get(`${B}/plans/:planId/payees`, wrap("GET", (_r, { planId }, url) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        return HttpResponse.json({ data: { payees: this.since(p.payees, kParam(url)).map((x) => this.strip(x)), server_knowledge: this.knowledge } });
      })),
      http.get(`${B}/plans/:planId/transactions`, wrap("GET", (_r, { planId }, url) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        const sinceDate = url.searchParams.get("since_date");
        const list = this.since(p.transactions, kParam(url)).filter((t) => !t.deleted && (!sinceDate || t.date >= sinceDate));
        return HttpResponse.json({ data: { transactions: list.map((t) => this.detail(p, t)), server_knowledge: this.knowledge } });
      })),
      http.get(`${B}/plans/:planId/transactions/:txnId`, wrap("GET", (_r, { planId, txnId }) => {
        const p = this.plans.get(planId ?? "");
        const t = p?.transactions.get(txnId ?? "");
        if (!p || !t) return notFound();
        return HttpResponse.json({ data: { transaction: this.detail(p, t), server_knowledge: this.knowledge } });
      })),
      http.post(`${B}/plans/:planId/transactions`, wrap("POST", (_r, { planId }, _u, body) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        const t = (body as { transaction?: Record<string, unknown> } | null)?.transaction;
        if (!t) return HttpResponse.json({ error: { id: "400", name: "bad_request", detail: "transaction missing" } }, { status: 400 });
        const id = `new-${this.nextId++}`;
        let payeeId = (t.payee_id as string | null | undefined) ?? null;
        if (!payeeId && typeof t.payee_name === "string") {
          payeeId = [...p.payees.values()].find((x) => x.name === t.payee_name)?.id ?? `p-new-${this.nextId++}`;
          if (!p.payees.has(payeeId)) this.putPayee(p.id, { id: payeeId, name: t.payee_name, transfer_account_id: null, deleted: false });
        }
        const raw: RawTxn = {
          id, date: String(t.date), amount: Number(t.amount), memo: (t.memo as string | null) ?? null,
          cleared: (t.cleared as RawTxn["cleared"]) ?? "uncleared", approved: Boolean(t.approved), flag_color: (t.flag_color as string | null) ?? null,
          account_id: String(t.account_id), payee_id: payeeId, category_id: (t.category_id as string | null) ?? null,
          transfer_account_id: null, transfer_transaction_id: null, matched_transaction_id: null,
          import_id: (t.import_id as string | null) ?? null, import_payee_name: null, import_payee_name_original: null, deleted: false,
        };
        this.putTxn(p.id, raw);
        const subs = (t.subtransactions as { amount: number; category_id: string; memo: string | null }[] | undefined) ?? [];
        subs.forEach((s, i) => this.putSub(p.id, { id: `${id}-s${i}`, transaction_id: id, amount: s.amount, memo: s.memo, payee_id: null,
          category_id: s.category_id, transfer_account_id: null, deleted: false }));
        const stored = p.transactions.get(id);
        if (!stored) return notFound();
        return HttpResponse.json({ data: { transaction_ids: [id], transaction: this.detail(p, stored), server_knowledge: this.knowledge } }, { status: 201 });
      })),
      http.patch(`${B}/plans/:planId/transactions`, wrap("PATCH", (_r, { planId }, _u, body) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        const list = (body as { transactions?: Record<string, unknown>[] } | null)?.transactions ?? [];
        const ids: string[] = [];
        for (const u of list) {
          const id = String(u.id);
          const cur = p.transactions.get(id);
          if (!cur) continue;
          const patch: Partial<RawTxn> = {};
          for (const key of ["category_id", "memo", "approved", "flag_color", "amount", "date"] as const) {
            if (key in u) (patch as Record<string, unknown>)[key] = u[key];
          }
          this.updateTxn(p.id, id, patch);
          const subs = u.subtransactions as { amount: number; category_id: string; memo: string | null }[] | undefined;
          subs?.forEach((s, i) => this.putSub(p.id, { id: `${id}-s${i}`, transaction_id: id, amount: s.amount, memo: s.memo, payee_id: null,
            category_id: s.category_id, transfer_account_id: null, deleted: false }));
          ids.push(id);
        }
        return HttpResponse.json({ data: {
          transaction_ids: ids,
          transactions: ids.flatMap((id) => { const t = p.transactions.get(id); return t ? [this.detail(p, t)] : []; }),
          server_knowledge: this.knowledge,
        } });
      })),
      http.delete(`${B}/plans/:planId/transactions/:txnId`, wrap("DELETE", (_r, { planId, txnId }) => {
        const p = this.plans.get(planId ?? "");
        const t = p?.transactions.get(txnId ?? "");
        if (!p || !t || t.deleted) return notFound();
        this.updateTxn(p.id, t.id, { deleted: true });
        const stored = p.transactions.get(t.id);
        return HttpResponse.json({ data: { transaction: stored ? this.detail(p, stored) : null, server_knowledge: this.knowledge } });
      })),
      // Plan export / delta: TransactionSummary rows (no payee_name/account_name) + a flat subtransactions array.
      http.get(`${B}/plans/:planId`, wrap("GET", (_r, { planId }, url) => {
        const p = this.plans.get(planId ?? "");
        if (!p) return notFound();
        const k = kParam(url);
        return HttpResponse.json({ data: {
          plan: {
            id: p.id, name: p.name, currency_format: { ...CURRENCY_EXTRA, ...p.currency },
            accounts: this.since(p.accounts, k).map((a) => this.strip(a)),
            payees: this.since(p.payees, k).map((x) => this.strip(x)),
            payee_locations: [],
            category_groups: this.since(p.groups, k).map((g) => ({ ...this.strip(g), internal: g.internal ?? false })),
            categories: this.since(p.categories, k).map((c) => ({ ...this.strip(c), internal: c.internal ?? false })),
            months: [],
            transactions: this.since(p.transactions, k).map((t) => this.strip(t)),
            subtransactions: this.since(p.subtransactions, k).map((s) => this.strip(s)),
            scheduled_transactions: [], scheduled_subtransactions: [],
          },
          server_knowledge: this.knowledge,
        } });
      })),
    ];
  }
}

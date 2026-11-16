// services/edit.ts — conversational edit of open intents (DESIGN §9.6).
//   preview: open intents + catalog → Claude (structured output) → resolve refs → checkActions → store the plan
//            (token, 15 min) → human-readable lines. With settings.autoApplyEdits and nothing that needs a
//            human (no question, nothing dropped, at most one delete) it applies at once.
//   apply:   claim the token once → re-run checkActions on the STORED actions against the current intents
//            (scope, ownership, plan, open, unchanged since preview, catalog) → run each action through the
//            same service functions as the HTTP routes → per-action results + one audit row with the words.
import { and, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { EditIntentsReq, EditRes } from "../../shared/api";
import { EditAction, type InputMode } from "../../shared/schemas";
import {
  buildPatches, checkActions, describeActions, isPatchAction, needsConfirmation, resolveModelPlan, type EditState, type OpenIntent,
} from "../ai/edit";
import { callStructured, getClaude } from "../ai/claude";
import { CATALOG_PAYEES, EDIT_SYSTEM, MAX_EDIT_ITEMS, renderCatalog, renderEditUserTurn, type EditPromptItem } from "../ai/prompts";
import { EditModelPlan } from "../ai/schemas";
import { editPlans, intents } from "../db/schema";
import { getLines, OPEN_STATUSES, runBatch } from "../engine/store";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { randomToken } from "../lib/ids";
import { getAccounts, getAllPayees, getCurrency, getSelectableCategories, getTopPayees, lastAccountForPayee } from "../ynab/cache";
import { cancelIntent, createIntents, extendIntent, keepIntent, updateIntent, type Base } from "./intents";

type EditResT = z.infer<typeof EditRes>;
type InputModeT = z.infer<typeof InputMode>;

/** §9.1-style call policy: extraction-like work → low effort; same bounds as parse. */
export const EDIT_CALL = { effort: "low", maxTokens: 8000, timeoutMs: 30_000, maxRetries: 1 } as const;
export const EDIT_PLAN_TTL_MS = 15 * 60_000;
const MAX_OPEN_LOADED = 500;

const StoredActions = z.array(z.object({ action: EditAction, line: z.string() }));
const StoredIds = z.array(z.string());
const StoredVersions = z.record(z.string(), z.number());

/** The user's open intents in the plan, newest first, with their lines. */
async function loadOpen(b: Base): Promise<OpenIntent[]> {
  const rows = await b.db.select().from(intents)
    .where(and(eq(intents.userId, b.userId), eq(intents.planId, b.planId), inArray(intents.status, [...OPEN_STATUSES])))
    .orderBy(desc(intents.createdAt)).limit(MAX_OPEN_LOADED).all();
  const lines = await getLines(b.db, rows.map((r) => r.id));
  return rows.map((row) => ({ row, lines: lines.get(row.id) ?? [] }));
}

async function loadCatalog(b: Base) {
  const [categories, allAccounts, currencyRow] = await Promise.all([
    getSelectableCategories(b.db, b.userId, b.planId),
    getAccounts(b.db, b.userId, b.planId),
    getCurrency(b.db, b.userId, b.planId),
  ]);
  // Intents are spending on budget accounts only (as in parse).
  const accounts = allAccounts.filter((a) => a.onBudget);
  return { categories, accounts, currency: { isoCode: currencyRow.isoCode, decimalDigits: currencyRow.decimalDigits } };
}

function stateOf(b: Base, open: OpenIntent[], cat: Awaited<ReturnType<typeof loadCatalog>>, selected: string[], text: string,
  versions?: Record<string, number>): EditState {
  return {
    intents: new Map(open.map((o) => [o.row.id, o])),
    selected: new Set(selected),
    categories: new Map(cat.categories.map((c) => [c.id, c.name])),
    accounts: new Map(cat.accounts.map((a) => [a.id, a.name])),
    today: b.today, currency: cat.currency, text, versions,
  };
}

// ── preview ─────────────────────────────────────────────────────────────────

export async function previewEdit(env: Env, b: Base, req: z.infer<typeof EditIntentsReq>): Promise<EditResT> {
  const now = Date.now();
  await b.db.delete(editPlans).where(and(eq(editPlans.userId, b.userId), lt(editPlans.expiresAt, now)));
  const open = await loadOpen(b);
  const openIds = new Set(open.map((o) => o.row.id));
  const selected = [...new Set(req.selectedIntentIds)];
  // Scope check before spending a Claude call: another user's id, another plan's or a closed one all look alike.
  if (selected.some((id) => !openIds.has(id))) {
    throw new AppError("conflict", "Some selected items are no longer open. Refresh and select again.");
  }
  const client = await getClaude(env, b.db, b.userId);         // consent + key
  const [cat, topPayees, allPayees] = await Promise.all([
    loadCatalog(b), getTopPayees(b.db, b.userId, b.planId, CATALOG_PAYEES), getAllPayees(b.db, b.userId, b.planId),
  ]);
  const catalog = renderCatalog({ categories: cat.categories, accounts: cat.accounts, payees: topPayees });
  const catRef = new Map([...catalog.categoryByRef].map(([ref, c]) => [c.id, ref]));
  const acctRef = new Map([...catalog.accountByRef].map(([ref, a]) => [a.id, ref]));

  // Listed items: the selected ones first, then the newest; refs i1.. in that order.
  const sel = new Set(selected);
  const listed = [...open.filter((o) => sel.has(o.row.id)), ...open.filter((o) => !sel.has(o.row.id))].slice(0, Math.max(MAX_EDIT_ITEMS, sel.size));
  const refs = new Map<string, string>();
  const items: EditPromptItem[] = listed.map((o, k) => {
    const ref = `i${k + 1}`;
    refs.set(ref, o.row.id);
    const r = o.row;
    return {
      ref, selected: sel.has(r.id), payee: r.payee, date: r.intentDate,
      accountRef: r.accountId ? (acctRef.get(r.accountId) ?? null) : null,
      accountName: r.accountId ? (cat.accounts.find((a) => a.id === r.accountId)?.name ?? null) : null,
      total: r.totalAmount, approximate: r.approximate, precision: r.precision, status: r.status, stale: r.expiresOn < b.today,
      editable: r.status === "pending" && !o.lines.some((l) => l.status === "matched"),
      placeholder: r.placeholderStatus === "created" && r.placeholderTxnId !== null, memo: r.memo,
      lines: o.lines.map((l) => ({
        categoryRef: catRef.get(l.categoryId) ?? null, categoryName: cat.categories.find((c) => c.id === l.categoryId)?.name ?? null,
        amount: l.amount, approximate: l.approximate, description: l.description, matched: l.status === "matched",
      })),
    };
  });

  const plan = await callStructured(client, {
    schema: EditModelPlan,
    system: [{ type: "text", text: EDIT_SYSTEM }, { type: "text", text: catalog.text }],
    user: renderEditUserTurn({
      today: b.today, timezone: b.settings.timezone, currency: cat.currency, items, omitted: open.length - listed.length, request: req.text,
    }),
    ...EDIT_CALL,
  });

  const state = stateOf(b, open, cat, selected, req.text);
  const resolved = resolveModelPlan(plan, { ...state, refs, catalog, payees: allPayees });
  const checked = checkActions(resolved.actions, state);
  const actions = checked.kept.map((k) => k.action);
  const dropped = [...resolved.dropped, ...checked.dropped.map((d) => d.reason)];

  // §9.4.6 for a new purchase: no explicit account → the payee's last account, then the default account.
  const defaultAccountId = b.settings.defaultAccountId !== null && state.accounts.has(b.settings.defaultAccountId) ? b.settings.defaultAccountId : null;
  for (const a of actions) {
    if (a.type !== "create_intent" || a.draft.accountId !== null) continue;
    const last = await lastAccountForPayee(b.db, b.userId, b.planId, a.draft.payee);
    a.draft.accountId = last !== null && state.accounts.has(last) ? last : defaultAccountId;
    a.draft.accountExplicit = false;
  }

  const lines = describeActions(actions, state);
  const warnings = [...resolved.warnings, ...[...buildPatches(actions, state).values()].flatMap((p) => (p.warning ? [p.warning] : []))];
  const summary = resolved.summary || (actions.length > 0 ? `${actions.length} change${actions.length === 1 ? "" : "s"}` : "Nothing to change");
  const base: EditResT = {
    token: null, expiresAt: null, summary, lines, dropped, question: resolved.question,
    needsConfirmation: false, applied: false, results: [], warnings,
  };
  if (actions.length === 0) return base;

  const token = randomToken(24);
  const expiresAt = now + EDIT_PLAN_TTL_MS;
  const targets = new Set(actions.flatMap((a) => (a.type === "create_intent" ? [] : [a.intentId])));
  const versions = Object.fromEntries([...targets].map((id) => [id, state.intents.get(id)?.row.updatedAt ?? 0]));
  await b.db.insert(editPlans).values({
    id: token, userId: b.userId, planId: b.planId, text: req.text, inputMode: req.inputMode,
    selectedIds: JSON.stringify(selected), summary,
    actions: JSON.stringify(actions.map((action, k) => ({ action, line: lines[k] ?? "" }))),
    versions: JSON.stringify(versions), createdAt: now, expiresAt, appliedAt: null,
  });

  const confirm = needsConfirmation({ autoApply: b.settings.autoApplyEdits, question: resolved.question, dropped: dropped.length, actions });
  if (!confirm) {
    const applied = await applyEdit(env, b, token);
    return { ...applied, warnings: [...warnings, ...applied.warnings] };
  }
  return { ...base, token, expiresAt, needsConfirmation: true };
}

// ── apply ───────────────────────────────────────────────────────────────────

export async function applyEdit(env: Env, b: Base, token: string): Promise<EditResT> {
  const now = Date.now();
  // Claim once: a double tap or a replayed token cannot run the plan twice.
  const plan = await b.db.update(editPlans).set({ appliedAt: now })
    .where(and(eq(editPlans.id, token), eq(editPlans.userId, b.userId), isNull(editPlans.appliedAt), gt(editPlans.expiresAt, now)))
    .returning().get();
  if (!plan) {
    const any = await b.db.select({ id: editPlans.id }).from(editPlans).where(and(eq(editPlans.id, token), eq(editPlans.userId, b.userId))).get();
    if (!any) throw new AppError("not_found", "This edit was not found. Preview it again.");
    throw new AppError("conflict", "This edit expired or was already applied. Preview it again.");
  }
  if (plan.planId !== b.planId) throw new AppError("conflict", "You switched YNAB plans since the preview. Preview the edit again.");

  const stored = StoredActions.parse(JSON.parse(plan.actions));
  const selected = StoredIds.parse(JSON.parse(plan.selectedIds));
  const versions = StoredVersions.parse(JSON.parse(plan.versions));
  const [open, cat] = await Promise.all([loadOpen(b), loadCatalog(b)]);
  const state = stateOf(b, open, cat, selected, plan.text, versions);
  const checked = checkActions(stored.map((s) => s.action), state);

  const results: EditResT["results"] = stored.map((s) => ({ line: s.line, ok: false, error: null }));
  for (const d of checked.dropped) {
    const r = results[d.index];
    if (r) r.error = d.reason;
  }
  const warnings = await execute(env, b, checked.kept, state, plan.text, plan.inputMode, results);

  const ok = results.filter((r) => r.ok).length;
  const targets = [...new Set(stored.flatMap((s) => (s.action.type === "create_intent" ? [] : [s.action.intentId])))];
  await runBatch(b.db, [auditStmt(b.db, {
    userId: b.userId, actor: "user", action: "intent_edit_conversational", intentId: targets.length === 1 ? targets[0] : null,
    summary: `Edit "${plan.text}": ${ok} of ${results.length} change${results.length === 1 ? "" : "s"} applied`,
  }, Date.now())]);

  return {
    token: null, expiresAt: null, summary: plan.summary, lines: stored.map((s) => s.line),
    dropped: [], question: null, needsConfirmation: false, applied: true, results, warnings,
  };
}

const failure = (e: unknown): string => {
  if (e instanceof AppError) return e.message;
  console.error(JSON.stringify({ msg: "edit_action_failed", error: e instanceof Error ? e.name : "unknown" }));
  return "Something went wrong";
};

/** Runs the kept actions in order. All PATCH-type actions on one intent become one updateIntent call (at the
 *  first of them); all new purchases one createIntents call (at the first). Each action gets its own result. */
async function execute(env: Env, b: Base, kept: { action: EditAction; index: number }[], state: EditState, text: string,
  inputMode: InputModeT, results: EditResT["results"]): Promise<string[]> {
  const warnings: string[] = [];
  const patches = buildPatches(kept.map((k) => k.action), state);
  const done = new Set<number>();
  const settle = (indexes: number[], error: string | null) => {
    for (const i of indexes) {
      done.add(i);
      const r = results[i];
      if (r) {
        r.ok = error === null;
        r.error = error;
      }
    }
  };
  for (const { action, index } of kept) {
    if (done.has(index)) continue;
    let group = [index];
    try {
      switch (action.type) {
        case "update_intent": case "update_line": case "add_line": case "remove_line": {
          group = kept.filter((k) => isPatchAction(k.action) && k.action.intentId === action.intentId).map((k) => k.index);
          const p = patches.get(action.intentId);
          if (!p || p.error) throw new AppError("validation", p?.error ?? "Invalid change");
          await updateIntent(env, b, action.intentId, p.patch, { note: text });
          if (p.warning) warnings.push(p.warning);
          break;
        }
        case "delete_intent":
          await cancelIntent(env, b, action.intentId);
          break;
        case "extend":
          await extendIntent(b, action.intentId, action.days);
          break;
        case "keep_final":
          await keepIntent(env, b, action.intentId);
          break;
        case "create_intent": {
          const creates = kept.filter((k) => k.action.type === "create_intent");
          group = creates.map((k) => k.index);
          const drafts = creates.flatMap((k) => (k.action.type === "create_intent" ? [k.action.draft] : []));
          const res = await createIntents(env, b, { intents: drafts, rawText: text, inputMode });
          warnings.push(...res.warnings);
          break;
        }
      }
      settle(group, null);
    } catch (e) {
      settle(group, failure(e));
    }
  }
  return warnings;
}


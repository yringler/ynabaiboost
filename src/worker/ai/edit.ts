// ai/edit.ts — conversational edit (DESIGN §9.6), PURE parts: Claude's plan (refs) → validated EditActions,
// the checks that run again at apply time, the per-intent PATCH bodies and the human-readable plan lines.
// Nothing here trusts the model: every ref is resolved against what the prompt listed, every id against the
// current open intents and the catalog, every number against bounds, and precision against the user's words.
import type { z } from "zod";
import { UpdateIntentReq } from "../../shared/api";
import { addDays } from "../../shared/dates";
import { formatMilli, roundToMinor, toMilli } from "../../shared/money";
import { assessPrecision, statedAmounts } from "../../shared/precision";
import { EditAction, IntentCreate, IsoDate, type CurrencyFormat, type Payee } from "../../shared/schemas";
import type { IntentRow, LineRow } from "../engine/store";
import { appendNote, factsAfterEdit, storedFacts } from "../domain/note";
import type { IntentPatch } from "../services/intents";
import { toDraft } from "./postprocess";
import { oneLine, type Catalog } from "./prompts";
import type { EditModelAction, EditModelPlan } from "./schemas";

type ModelPlan = z.infer<typeof EditModelPlan>;
type ModelAction = z.infer<typeof EditModelAction>;

/** Most actions one request may produce; the rest are dropped with a reason. */
export const MAX_EDIT_ACTIONS = 30;
/** Largest amount an edit may set, in currency units. */
export const MAX_EDIT_AMOUNT = 1_000_000;
/** How far back an edited date may go. */
export const MAX_EDIT_DATE_AGE_DAYS = 365;
export const DEFAULT_EXTEND_DAYS = 7;
const MAX_LINES = 20;
const MAX_TEXT = 200;

export interface OpenIntent { row: IntentRow; lines: LineRow[] }

/** What the actions are checked against: the user's open intents in the current plan and the catalog. */
export interface EditState {
  intents: Map<string, OpenIntent>;
  /** Scope: non-empty ⇒ only these intents may be targeted (create_intent excepted). */
  selected: Set<string>;
  categories: Map<string, string>;          // selectable category id → name
  accounts: Map<string, string>;            // open on-budget account id → name
  today: string;
  currency: CurrencyFormat;
  /** The user's request: amounts in it count as stated by the user (§9.5). */
  text: string;
  /** Preview-time updated_at per intent; set at apply time to refuse intents that changed since. */
  versions?: Record<string, number> | undefined;
}

export interface ResolveCtx extends EditState {
  refs: Map<string, string>;                // prompt ref (i1..) → intent id
  catalog: Pick<Catalog, "categoryByRef" | "accountByRef">;
  payees: Payee[];
}

export interface Resolved {
  summary: string;
  actions: EditAction[];
  dropped: string[];
  question: string | null;
  warnings: string[];
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) : s);
const clean = (s: string | null | undefined): string => clip(oneLine(s ?? ""));

export const intentLabel = (row: Pick<IntentRow, "payee">): string => clip(oneLine(row.payee), 60) || "Item";

/** Currency units → positive milliunits within bounds, or null. */
export function editAmount(units: number | null | undefined, decimalDigits: number): number | null {
  if (units === null || units === undefined || !Number.isFinite(units) || units <= 0 || units > MAX_EDIT_AMOUNT) return null;
  const m = roundToMinor(toMilli(units), decimalDigits);
  return m > 0 ? m : null;
}

/** A date an edit may set: a real calendar date, not in the future, at most a year back. */
export function editDate(s: string | null | undefined, today: string): string | null {
  const d = (s ?? "").trim();
  if (!IsoDate.safeParse(d).success || d > today || d < addDays(today, -MAX_EDIT_DATE_AGE_DAYS)) return null;
  return d;
}

/** True when `milli` is written in the text with explicit minor units (the deterministic "stated" test). */
const statedIn = (text: string, milli: number, dd: number): boolean => statedAmounts(text, dd).exact.has(milli);

// ── 1. resolve the model's plan (refs → ids) ─────────────────────────────────

export function resolveModelPlan(plan: ModelPlan, ctx: ResolveCtx): Resolved {
  const dd = ctx.currency.decimalDigits;
  const out: Resolved = { summary: clip(oneLine(plan.summary), 300), actions: [], dropped: [], question: null, warnings: [] };
  const ask = (q: string) => {
    const t = clip(oneLine(q), 300);
    if (t !== "" && out.question === null) out.question = t;
  };
  const drop = (reason: string) => out.dropped.push(reason);

  plan.actions.forEach((a, k) => {
    if (a.type === "clarify") return ask(a.question);
    if (k >= MAX_EDIT_ACTIONS) return drop(`Only the first ${MAX_EDIT_ACTIONS} changes are kept`);
    if (a.type === "create_intent") {
      const r = resolveCreate(a, ctx, out.warnings);
      if ("error" in r) drop(r.error);
      else out.actions.push(r.action);
      return;
    }
    const intentId = ctx.refs.get(a.intent_ref.trim());
    const target = intentId ? ctx.intents.get(intentId) : undefined;
    if (!intentId || !target) return drop(`Claude referred to an item that isn't in your list (${clip(oneLine(a.intent_ref), 20)})`);
    const r = resolveIntentAction(a, intentId, target, ctx, dd);
    if ("error" in r) drop(r.error);
    else out.actions.push(r.action);
  });
  return out;
}

type R = { action: EditAction } | { error: string };

function resolveIntentAction(a: Exclude<ModelAction, { type: "clarify" | "create_intent" }>, intentId: string, t: OpenIntent,
  ctx: ResolveCtx, dd: number): R {
  const name = intentLabel(t.row);
  const combined = appendNote(t.row.rawText, ctx.text);
  const lineIndex = (n: number): number | null => (Number.isInteger(n) && n >= 1 && n <= t.lines.length ? n - 1 : null);
  const category = (ref: string | null): string | null | "bad" => {
    if (ref === null) return null;
    return ctx.catalog.categoryByRef.get(ref.trim())?.id ?? "bad";
  };
  switch (a.type) {
    case "update_intent": {
      const payee = a.payee === null ? null : clean(a.payee);
      let date: string | null = null;
      if (a.date !== null) {
        date = editDate(a.date, ctx.today);
        if (date === null) return { error: `${name}: "${clip(oneLine(a.date), 20)}" is not a date the app can use (future or more than a year ago)` };
      }
      let accountId: string | null = null;
      if (a.account_ref !== null) {
        accountId = ctx.catalog.accountByRef.get(a.account_ref.trim())?.id ?? null;
        if (accountId === null) return { error: `${name}: that account isn't one of your budget accounts` };
      }
      let totalAmount: number | null = null;
      let approximate: boolean | null = null;
      if (a.total_amount !== null) {
        totalAmount = editAmount(a.total_amount, dd);
        if (totalAmount === null) return { error: `${name}: the amount must be positive and at most ${MAX_EDIT_AMOUNT.toLocaleString("en-US")}` };
        approximate = a.total_is_approximate === true || !statedIn(combined, totalAmount, dd);
      }
      const memo = a.memo === null ? null : clean(a.memo);
      const action: EditAction = {
        type: "update_intent", intentId, payee: payee === "" ? null : payee, date, accountId,
        memo: memo === "" ? null : memo, clearMemo: memo === "", totalAmount, approximate,
      };
      if (action.payee === null && date === null && accountId === null && action.memo === null && !action.clearMemo && totalAmount === null) {
        return { error: `${name}: nothing to change` };
      }
      return { action };
    }
    case "update_line": {
      const idx = lineIndex(a.line_number);
      if (idx === null) return { error: `${name}: there is no line ${a.line_number}` };
      const categoryId = category(a.category_ref);
      if (categoryId === "bad") return { error: `${name}: that category isn't in your budget (the app never creates categories)` };
      let amount: number | null = null;
      let approximate: boolean | null = null;
      if (a.amount !== null) {
        amount = editAmount(a.amount, dd);
        if (amount === null) return { error: `${name}: the amount must be positive and at most ${MAX_EDIT_AMOUNT.toLocaleString("en-US")}` };
        approximate = a.amount_is_estimate === true || !statedIn(combined, amount, dd);
      }
      const description = a.description === null ? null : clean(a.description) || null;
      if (categoryId === null && amount === null && description === null) return { error: `${name}: nothing to change on line ${a.line_number}` };
      return { action: { type: "update_line", intentId, lineIndex: idx, categoryId, amount, approximate, description } };
    }
    case "add_line": {
      const categoryId = category(a.category_ref);
      if (categoryId === "bad" || categoryId === null) return { error: `${name}: that category isn't in your budget (the app never creates categories)` };
      const amount = editAmount(a.amount, dd);
      if (amount === null) return { error: `${name}: the new line needs a positive amount` };
      const description = clean(a.description) || (ctx.categories.get(categoryId) ?? name);
      return { action: { type: "add_line", intentId, categoryId, amount, approximate: a.amount_is_estimate || !statedIn(combined, amount, dd), description: clip(description) } };
    }
    case "remove_line": {
      const idx = lineIndex(a.line_number);
      if (idx === null) return { error: `${name}: there is no line ${a.line_number}` };
      return { action: { type: "remove_line", intentId, lineIndex: idx } };
    }
    case "delete_intent":
      return { action: { type: "delete_intent", intentId } };
    case "extend": {
      const days = a.days ?? DEFAULT_EXTEND_DAYS;
      if (!Number.isInteger(days) || days < 1 || days > 90) return { error: `${name}: can extend by 1 to 90 days` };
      return { action: { type: "extend", intentId, days } };
    }
    case "keep_final":
      return { action: { type: "keep_final", intentId } };
  }
}

function resolveCreate(a: Extract<ModelAction, { type: "create_intent" }>, ctx: ResolveCtx, warnings: string[]): R {
  const w: string[] = [];
  const draft = toDraft(a.transaction, { catalog: ctx.catalog, payees: ctx.payees, today: ctx.today, decimalDigits: ctx.currency.decimalDigits, text: ctx.text }, w, 0);
  const name = clip(oneLine(a.transaction.payee), 60) || "new purchase";
  if (!draft) return { error: `New ${name}: couldn't read this purchase` };
  if (draft.totalAmount === null || draft.totalAmount > MAX_EDIT_AMOUNT * 1000) return { error: `New ${draft.payee}: no usable amount; add it from Capture` };
  if (draft.lines.some((l) => l.categoryId === null)) return { error: `New ${draft.payee}: no matching category in your budget; add it from Capture` };
  const parsed = IntentCreate.safeParse({ ...draft, createPlaceholder: true });
  if (!parsed.success) return { error: `New ${draft.payee}: every item needs an amount; add it from Capture` };
  warnings.push(...w.map((x) => `New ${draft.payee}: ${x}`));
  return { action: { type: "create_intent", draft: parsed.data } };
}

// ── 2. checks shared by preview and apply ────────────────────────────────────

const PATCH_TYPES = new Set<EditAction["type"]>(["update_intent", "update_line", "add_line", "remove_line"]);
type PatchAction = Extract<EditAction, { type: "update_intent" | "update_line" | "add_line" | "remove_line" }>;
export const isPatchAction = (a: EditAction): a is PatchAction => PATCH_TYPES.has(a.type);

export interface Checked { kept: { action: EditAction; index: number }[]; dropped: { index: number; reason: string }[] }

/** Ownership/plan/open, scope, version, editability, line indexes, catalog ids, conflicting actions, and the
 *  resulting PATCH body for every touched intent. Runs at preview AND at apply (on the stored actions). */
export function checkActions(actions: EditAction[], s: EditState): Checked {
  const out: Checked = { kept: [], dropped: [] };
  const deleted = new Set(actions.flatMap((a) => (a.type === "delete_intent" ? [a.intentId] : [])));
  const seenDelete = new Set<string>();
  const reasonFor = (a: EditAction): string | null => {
    if (a.type === "create_intent") {
      const unknown = a.draft.lines.find((l) => !s.categories.has(l.categoryId));
      if (unknown) return `New ${intentLabel(a.draft)}: that category isn't in your budget`;
      if (a.draft.accountId !== null && !s.accounts.has(a.draft.accountId)) return `New ${intentLabel(a.draft)}: that account isn't one of your budget accounts`;
      return null;
    }
    const t = s.intents.get(a.intentId);
    if (!t) return "That item is no longer open (it was matched, deleted or belongs to another plan)";
    const name = intentLabel(t.row);
    if (s.selected.size > 0 && !s.selected.has(a.intentId)) return `${name} isn't selected. Select it to change it`;
    if (s.versions && s.versions[a.intentId] !== undefined && s.versions[a.intentId] !== t.row.updatedAt) {
      return `${name} changed since the preview. Preview the edit again`;
    }
    if (a.type === "delete_intent") {
      if (seenDelete.has(a.intentId)) return `${name} is already being deleted`;
      seenDelete.add(a.intentId);
      return null;
    }
    if (deleted.has(a.intentId)) return `${name} is being deleted, so it isn't changed`;
    if (a.type === "extend") return null;
    if (a.type === "keep_final") {
      return t.row.placeholderStatus === "created" && t.row.placeholderTxnId ? null : `${name} has no placeholder in YNAB to keep as final`;
    }
    // patch actions
    if (t.row.status !== "pending" || t.lines.some((l) => l.status === "matched")) {
      return `${name}: only pending items with nothing matched yet can be edited`;
    }
    if ((a.type === "update_line" || a.type === "remove_line") && !t.lines[a.lineIndex]) return `${name}: there is no line ${a.lineIndex + 1}`;
    if ((a.type === "update_line" || a.type === "add_line") && a.categoryId !== null && !s.categories.has(a.categoryId)) {
      return `${name}: that category isn't in your budget`;
    }
    if (a.type === "update_intent" && a.accountId !== null && !s.accounts.has(a.accountId)) return `${name}: that account isn't one of your budget accounts`;
    if (a.type === "update_intent" && a.date !== null && editDate(a.date, s.today) === null) return `${name}: that date can't be used`;
    return null;
  };
  actions.forEach((action, index) => {
    const reason = reasonFor(action);
    if (reason) out.dropped.push({ index, reason });
    else out.kept.push({ action, index });
  });
  // Whole-intent patch validity (line count, amounts): a bad combination drops every action on that intent.
  const patches = buildPatches(out.kept.map((k) => k.action), s);
  const bad = new Set([...patches].flatMap(([id, p]) => (p.error ? [id] : [])));
  if (bad.size > 0) {
    out.kept = out.kept.filter((k) => {
      if (!isPatchAction(k.action) || !bad.has(k.action.intentId)) return true;
      out.dropped.push({ index: k.index, reason: patches.get(k.action.intentId)?.error ?? "Invalid change" });
      return false;
    });
    out.dropped.sort((x, y) => x.index - y.index);
  }
  return out;
}

// ── 3. one PATCH per intent ──────────────────────────────────────────────────

export interface BuiltPatch {
  patch: IntentPatch;
  /** The intent as it would be after the patch (for the plan lines and precision). */
  total: number; approximate: boolean; lines: { amount: number; approximate: boolean; categoryId: string }[];
  linesChanged: boolean;
  error: string | null;
  warning: string | null;
}

/** Line edits refer to the lines as they were listed (original indexes); they are applied together. */
export function buildPatches(actions: EditAction[], s: EditState): Map<string, BuiltPatch> {
  const out = new Map<string, BuiltPatch>();
  const byIntent = new Map<string, PatchAction[]>();
  for (const a of actions) {
    if (!isPatchAction(a)) continue;
    byIntent.set(a.intentId, [...(byIntent.get(a.intentId) ?? []), a]);
  }
  for (const [intentId, as] of byIntent) {
    const t = s.intents.get(intentId);
    if (!t) continue;
    const name = intentLabel(t.row);
    const lines = t.lines.map((l) => ({ description: l.description, categoryId: l.categoryId, amount: l.amount, approximate: l.approximate, confidence: null, removed: false }));
    const patch: IntentPatch = {};
    let linesChanged = false;
    let explicitTotal: number | null = null;
    let explicitApprox: boolean | null = null;
    for (const a of as) {
      if (a.type === "update_intent") {
        if (a.payee !== null) patch.payee = a.payee;
        if (a.date !== null) patch.date = a.date;
        if (a.accountId !== null) patch.accountId = a.accountId;
        if (a.clearMemo) patch.memo = null;
        else if (a.memo !== null) patch.memo = a.memo;
        if (a.totalAmount !== null) {
          explicitTotal = a.totalAmount;
          explicitApprox = a.approximate ?? true;
        }
      } else if (a.type === "update_line") {
        const l = lines[a.lineIndex];
        if (!l) continue;
        linesChanged = true;
        if (a.categoryId !== null) l.categoryId = a.categoryId;
        if (a.amount !== null) {
          l.amount = a.amount;
          l.approximate = a.approximate ?? true;
        }
        if (a.description !== null) l.description = a.description;
      } else if (a.type === "remove_line") {
        const l = lines[a.lineIndex];
        if (l) l.removed = true;
        linesChanged = true;
      } else {
        lines.push({ description: a.description, categoryId: a.categoryId, amount: a.amount, approximate: a.approximate, confidence: null, removed: false });
        linesChanged = true;
      }
    }
    const kept = lines.filter((l) => !l.removed);
    let error: string | null = null;
    let warning: string | null = null;
    if (linesChanged) {
      if (kept.length === 0) error = `${name}: can't remove every line; delete the item instead`;
      else if (kept.length > MAX_LINES) error = `${name}: at most ${MAX_LINES} lines`;
      patch.lines = kept.map(({ removed: _r, ...l }) => l);
    }
    // Total: an explicit total wins (a single line then takes it, as in PATCH); otherwise changed lines sum up.
    const total = explicitTotal ?? (linesChanged ? kept.reduce((x, l) => x + l.amount, 0) : t.row.totalAmount);
    let approximate = t.row.approximate;
    if (explicitTotal !== null) {
      patch.totalAmount = explicitTotal;
      patch.approximate = approximate = explicitApprox ?? true;
    } else if (linesChanged) {
      patch.approximate = approximate = kept.some((l) => l.approximate);
    }
    // A single line always follows an explicit total (sent as `lines`, so PATCH rewrites that line too).
    const only = kept.length === 1 ? kept[0] : undefined;
    const finalLines = only && explicitTotal !== null ? [{ ...only, amount: total, approximate }] : kept;
    if (only && explicitTotal !== null) patch.lines = finalLines.map(({ removed: _r, ...l }) => l);
    if (finalLines.length > 1 && explicitTotal !== null) {
      const sum = finalLines.reduce((x, l) => x + l.amount, 0);
      if (sum !== total) warning = `${name}: the lines add up to ${money(sum, false, s.currency)}, not the new total`;
    }
    if (!error) {
      const checked = UpdateIntentReq.safeParse(patch);
      if (!checked.success) error = `${name}: that change isn't valid`;
    }
    out.set(intentId, {
      patch, total, approximate, linesChanged, error, warning,
      lines: finalLines.map((l) => ({ amount: l.amount, approximate: l.approximate, categoryId: l.categoryId })),
    });
  }
  return out;
}

// ── 4. human-readable plan ───────────────────────────────────────────────────

export const money = (m: number, approx: boolean, c: CurrencyFormat): string =>
  `${approx ? "≈" : ""}${formatMilli(m, c, "en-US")}`;
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const shortDate = (iso: string): string => DAY.format(new Date(`${iso}T12:00:00Z`));

/** One line per action, in order. The intent's new total (with its deterministic precision) is shown on the
 *  action that sets it, or on the last line action of that intent. */
export function describeActions(actions: EditAction[], s: EditState): string[] {
  const patches = buildPatches(actions, s);
  const totalShownOn = new Map<string, number>();
  actions.forEach((a, k) => {
    if (isPatchAction(a) && a.type !== "update_intent") totalShownOn.set(a.intentId, k);
  });
  actions.forEach((a, k) => {
    if (a.type === "update_intent" && a.totalAmount !== null) totalShownOn.set(a.intentId, k);
  });
  const cat = (id: string) => s.categories.get(id) ?? "Unknown category";
  return actions.map((a, k) => {
    if (a.type === "create_intent") {
      const d = a.draft;
      const cats = [...new Set(d.lines.map((l) => cat(l.categoryId)))].join(", ");
      const acct = d.accountId ? ` · ${s.accounts.get(d.accountId) ?? "account"}` : "";
      return `New: ${intentLabel(d)} ${money(d.totalAmount, d.approximate, s.currency)} · ${cats}${d.date !== s.today ? ` · ${shortDate(d.date)}` : ""}${acct}`;
    }
    const t = s.intents.get(a.intentId);
    const name = t ? intentLabel(t.row) : "Item";
    const row = t?.row;
    switch (a.type) {
      case "delete_intent":
        return `Delete: ${name} ${row ? money(row.totalAmount, row.approximate, s.currency) : ""}`.trim();
      case "extend":
        return `${name} · keep watching ${a.days} more days (until ${shortDate(addDays(row && row.expiresOn > s.today ? row.expiresOn : s.today, a.days))})`;
      case "keep_final":
        return `${name} · keep the placeholder as the final entry`;
      default: {
        const parts: string[] = [];
        if (a.type === "update_intent" && row) {
          if (a.payee !== null) parts.push(`payee ${row.payee} → ${a.payee}`);
          if (a.date !== null) parts.push(`date ${shortDate(row.intentDate)} → ${shortDate(a.date)}`);
          if (a.accountId !== null) parts.push(`account ${row.accountId ? (s.accounts.get(row.accountId) ?? "unknown") : "none"} → ${s.accounts.get(a.accountId) ?? "unknown"}`);
          if (a.clearMemo) parts.push("memo cleared");
          else if (a.memo !== null) parts.push(`memo → "${a.memo}"`);
        } else if (a.type === "update_line") {
          const l = t?.lines[a.lineIndex];
          const what: string[] = [];
          if (a.categoryId !== null) what.push(`${l ? cat(l.categoryId) : "?"} → ${cat(a.categoryId)}`);
          if (a.amount !== null) what.push(`${l ? money(l.amount, l.approximate, s.currency) : "?"} → ${money(a.amount, a.approximate ?? true, s.currency)}`);
          if (a.description !== null) what.push(`"${a.description}"`);
          parts.push(`line ${a.lineIndex + 1}${l ? ` (${clip(l.description, 40)})` : ""}: ${what.join(", ")}`);
        } else if (a.type === "add_line") {
          parts.push(`add ${cat(a.categoryId)} ${money(a.amount, a.approximate, s.currency)}${a.description.toLowerCase() !== cat(a.categoryId).toLowerCase() ? ` (${clip(a.description, 40)})` : ""}`);
        } else if (a.type === "remove_line") {
          const l = t?.lines[a.lineIndex];
          parts.push(`remove line ${a.lineIndex + 1}${l ? ` (${clip(l.description, 40)}, ${money(l.amount, l.approximate, s.currency)})` : ""}`);
        }
        const p = patches.get(a.intentId);
        if (p && row && t && totalShownOn.get(a.intentId) === k && (p.total !== row.totalAmount || p.approximate !== row.approximate || (a.type === "update_intent" && a.totalAmount !== null))) {
          const level = precisionOf(t, p, s);
          parts.push(`total ${money(row.totalAmount, row.approximate, s.currency)} → ${money(p.total, p.approximate, s.currency)} (${level})`);
        }
        return `${name} · ${parts.join(" · ")}`;
      }
    }
  });
}

/** The precision the executor will store: the same assessPrecision over raw_text + the request (§9.5). */
export function precisionOf(t: OpenIntent, p: BuiltPatch, s: EditState): "exact" | "approximate" {
  return assessPrecision(
    { merchantKind: t.row.merchantKind, totalAmount: p.total, approximate: p.approximate, lines: p.lines,
      facts: factsAfterEdit(storedFacts(t.row.orderFacts), s.text, t.row.totalAmount, p.total, s.currency.decimalDigits) },
    appendNote(t.row.rawText, s.text), s.currency.decimalDigits,
  ).level;
}

/** Owner rule (§9.6): even with auto-apply on, ask when Claude asked something, anything was dropped, or the
 *  plan deletes more than one item. */
export function needsConfirmation(a: { autoApply: boolean; question: string | null; dropped: number; actions: EditAction[] }): boolean {
  const deletes = a.actions.filter((x) => x.type === "delete_intent").length;
  return !a.autoApply || a.question !== null || a.dropped > 0 || deletes > 1;
}

export { EditAction };

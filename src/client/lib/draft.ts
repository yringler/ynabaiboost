// lib/draft.ts — WP6: editable form state for one IntentDraft (DraftEditor) and its conversion to IntentCreate.
// Amounts are kept as the user's text so half-typed values ("12.") don't fight the input.
import { bestPayeeMatch } from "../../shared/payee";
import {
  IntentCreate, type ConfidenceT, type IntentDraft, type MerchantKind, type Payee,
} from "../../shared/schemas";
import type { Direction } from "../../shared/money";
import { hasApproxMarker, milliToInput, parseMoneyInput } from "./format";

export interface LineState {
  key: string;
  description: string;
  categoryId: string | null;
  amountText: string;
  approximate: boolean;
  confidence: ConfidenceT | null;
}

export interface DraftState {
  key: string;
  payee: string;
  payeeId: string | null;
  merchantKind: MerchantKind;
  direction: Direction;
  date: string;
  accountId: string | null;
  accountExplicit: boolean;
  totalText: string;
  approximate: boolean;
  memo: string;
  lines: LineState[];
  createPlaceholder: boolean;
}

let seq = 0;
export const newKey = (prefix: string): string => `${prefix}${++seq}`;

export function lineFromDraft(l: IntentDraft["lines"][number], decimals: number): LineState {
  return {
    key: newKey("l"), description: l.description, categoryId: l.categoryId,
    amountText: milliToInput(l.amount, decimals), approximate: l.approximate, confidence: l.confidence,
  };
}

export function draftToState(d: IntentDraft, decimals: number, createPlaceholder: boolean): DraftState {
  return {
    key: newKey("d"), payee: d.payee, payeeId: d.payeeId, merchantKind: d.merchantKind, direction: d.direction,
    date: d.date, accountId: d.accountId, accountExplicit: d.accountExplicit,
    totalText: milliToInput(d.totalAmount, decimals), approximate: d.approximate, memo: d.memo ?? "",
    lines: d.lines.map((l) => lineFromDraft(l, decimals)), createPlaceholder,
  };
}

export function emptyLine(): LineState {
  return { key: newKey("l"), description: "", categoryId: null, amountText: "", approximate: false, confidence: null };
}

/** The "Enter manually" draft (§11.2: offered when parsing fails with an ai_* error). */
export function emptyDraft(today: string, createPlaceholder: boolean, text = ""): DraftState {
  return {
    key: newKey("d"), payee: "", payeeId: null, merchantKind: "in_person", direction: "outflow", date: today,
    accountId: null, accountExplicit: false, totalText: "", approximate: false, memo: "",
    lines: [{ ...emptyLine(), description: text.slice(0, 200) }], createPlaceholder,
  };
}

/** Recompute payeeId after the user edits the payee (same rule as the worker: bestPayeeMatch ≥ 0.9). */
export function resolvePayeeId(name: string, payees: Payee[]): string | null {
  const n = name.trim();
  if (!n) return null;
  return bestPayeeMatch(n, payees)?.id ?? null;
}

export interface DraftSums {
  total: number | null;
  lineSum: number;
  /** Lines with a parseable positive amount. */
  linesWithAmount: number;
  /** For multi-line drafts: every line has an amount and they add up to the total. */
  balanced: boolean;
}

export function draftSums(d: DraftState, decimals: number): DraftSums {
  const total = parseMoneyInput(d.totalText, decimals);
  let lineSum = 0;
  let linesWithAmount = 0;
  for (const l of d.lines) {
    const a = parseMoneyInput(l.amountText, decimals);
    if (a !== null) {
      lineSum += a;
      linesWithAmount++;
    }
  }
  const balanced = d.lines.length <= 1 || (linesWithAmount === d.lines.length && total !== null && lineSum === total);
  return { total, lineSum, linesWithAmount, balanced };
}

export type DraftResult = { ok: true; value: IntentCreate } | { ok: false; errors: string[] };

/** Validates the form and builds the IntentCreate the worker expects (re-checked with the shared zod schema). */
export function stateToIntentCreate(d: DraftState, decimals: number): DraftResult {
  const errors: string[] = [];
  const payee = d.payee.trim();
  if (!payee) errors.push("Payee is required");
  const total = parseMoneyInput(d.totalText, decimals);
  if (total === null) errors.push("Enter a total amount");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) errors.push("Pick a date");
  if (d.lines.length === 0) errors.push("Add at least one item");

  const lines: IntentCreate["lines"] = [];
  d.lines.forEach((l, i) => {
    const label = d.lines.length > 1 ? `Item ${i + 1}: ` : "";
    if (!l.categoryId) errors.push(`${label}pick a category`);
    const single = d.lines.length === 1;
    const amt = !single && l.amountText.trim() ? parseMoneyInput(l.amountText, decimals) : null;
    if (!single && l.amountText.trim() && amt === null) errors.push(`${label}amount is not valid`);
    if (d.lines.length > 1 && amt === null && !l.amountText.trim()) errors.push(`${label}needs an amount`);
    lines.push({
      description: l.description.trim() || payee || "Purchase",
      categoryId: l.categoryId ?? "",
      // A single line carries the total (its own amount field is hidden in the editor).
      amount: single ? total : amt,
      approximate: single ? d.approximate || hasApproxMarker(d.totalText) : l.approximate || hasApproxMarker(l.amountText),
      confidence: l.confidence,
    });
  });
  const sums = draftSums(d, decimals);
  if (d.lines.length > 1 && total !== null && sums.linesWithAmount === d.lines.length && !sums.balanced) {
    errors.push("Item amounts must add up to the total");
  }
  if (errors.length > 0 || total === null) return { ok: false, errors };

  const candidate = {
    payee, payeeId: d.payeeId, merchantKind: d.merchantKind, direction: d.direction, date: d.date,
    accountId: d.accountId, accountExplicit: d.accountExplicit, totalAmount: total,
    approximate: d.approximate || hasApproxMarker(d.totalText), memo: d.memo.trim() || null,
    lines, createPlaceholder: d.createPlaceholder,
  };
  const parsed = IntentCreate.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  return { ok: true, value: parsed.data };
}

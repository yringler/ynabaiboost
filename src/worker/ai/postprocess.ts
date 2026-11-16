// ai/postprocess.ts — WP4 (DESIGN §9.4 "Parsing"). PURE: Claude's ParsedUtterance → IntentDrafts + warnings.
// The account fallback (lastAccountForPayee → settings.defaultAccountId) needs the DB and is done by parse.ts.
import type { z } from "zod";
import { addDays } from "../../shared/dates";
import { minorUnit, roundToMinor, toMilli, type Direction } from "../../shared/money";
import { bestPayeeMatch } from "../../shared/payee";
import { IntentDraft, IsoDate, type IntentLineDraft, type Payee } from "../../shared/schemas";
import type { Catalog } from "./prompts";
import type { ParsedTransaction, ParsedUtterance } from "./schemas";

type Parsed = z.infer<typeof ParsedUtterance>;
type ParsedTxn = z.infer<typeof ParsedTransaction>;
type DirectionT = Direction;

export const MAX_DRAFTS = 10;          // CreateIntentsReq.intents max
export const MAX_LINES = 20;           // IntentDraft.lines max
export const OLD_DATE_DAYS = 60;
const MAX_TEXT = 200;

export interface PostprocessCtx {
  catalog: Pick<Catalog, "categoryByRef" | "accountByRef">;
  payees: Payee[];                     // getAllPayees, for bestPayeeMatch
  today: string;                       // YYYY-MM-DD in the user's timezone
  decimalDigits: number;
}

export interface PostprocessResult {
  status: Parsed["status"];
  question: string | null;
  drafts: IntentDraft[];
  warnings: string[];
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) : s);

/** Currency units → positive milliunits rounded to the plan's minor unit. */
export const toPositiveMilli = (units: number, decimalDigits: number): number =>
  roundToMinor(Math.abs(toMilli(units)), decimalDigits);

/** Tolerance for the "lines don't add up" warning only (the matcher has its own, §10.2). */
export function sumTolerance(total: number, approximate: boolean, decimalDigits: number): number {
  return approximate ? Math.max(1000, Math.round(total * 0.05)) : minorUnit(decimalDigits);
}

function validIsoDate(s: string): boolean {
  return IsoDate.safeParse(s).success;
}

function flip(d: DirectionT): DirectionT {
  return d === "outflow" ? "inflow" : "outflow";
}

/** One ParsedTransaction → draft (or null with a warning if it can't be made valid). `n` labels warnings. */
export function toDraft(t: ParsedTxn, ctx: PostprocessCtx, warnings: string[], n: number): IntentDraft | null {
  const label = (s: string) => (n > 0 ? `#${n}: ${s}` : s);
  const dd = ctx.decimalDigits;

  // payee → cached payee id + spelling (§9.4.3)
  let payee = clip(t.payee.replace(/\s+/g, " ").trim());
  let payeeId: string | null = null;
  if (payee === "") {
    payee = "Unknown payee";
    warnings.push(label("no payee recognised"));
  } else {
    const match = bestPayeeMatch(payee, ctx.payees, 0.9);
    if (match) {
      payee = clip(match.name);
      payeeId = match.id;
    } else {
      warnings.push(label(`new payee "${payee}"`));
    }
  }

  // direction: a negative amount flips it (§9.4.2)
  let direction: DirectionT = t.direction;
  const signSource = t.total_amount ?? t.lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  if (signSource < 0) direction = flip(direction);

  let totalAmount = t.total_amount === null ? null : toPositiveMilli(t.total_amount, dd);
  const approximate = t.total_is_approximate;

  // lines: refs → ids (unknown refs dropped with a warning, §9.4.1)
  let lines: IntentLineDraft[] = t.lines.map((l) => {
    let categoryId: string | null = null;
    if (l.category_ref !== null) {
      const cat = ctx.catalog.categoryByRef.get(l.category_ref.trim());
      if (cat) categoryId = cat.id;
      else warnings.push(label(`unknown category "${l.category_ref}" dropped`));
    }
    const description = clip(l.description.replace(/\s+/g, " ").trim());
    return {
      description: description === "" ? payee : description,
      categoryId,
      amount: l.amount === null ? null : toPositiveMilli(l.amount, dd),
      approximate: l.amount_is_estimate,
      confidence: categoryId === null ? "low" : l.category_confidence,
    };
  });
  if (lines.length > MAX_LINES) {
    warnings.push(label(`only the first ${MAX_LINES} items were kept`));
    lines = lines.slice(0, MAX_LINES);
  }
  if (lines.length === 0) {
    lines = [{ description: clip(t.memo?.trim() || payee), categoryId: null, amount: totalAmount, approximate, confidence: "low" }];
  }

  // line amounts (§9.4.4)
  const allHaveAmounts = lines.every((l) => l.amount !== null);
  if (totalAmount === null && allHaveAmounts) {
    totalAmount = lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  }
  if (lines.length === 1 && lines[0] && lines[0].amount === null && totalAmount !== null) {
    lines[0] = { ...lines[0], amount: totalAmount, approximate: lines[0].approximate || approximate };
  }
  if (lines.length > 1 && !allHaveAmounts) {
    warnings.push(label("some items have no amount; enter them before saving"));
  }
  if (t.merchant_kind !== "amazon" && totalAmount !== null && lines.length > 1 && lines.every((l) => l.amount !== null)) {
    const sum = lines.reduce((s, l) => s + (l.amount ?? 0), 0);
    if (Math.abs(sum - totalAmount) > sumTolerance(totalAmount, approximate, dd)) {
      warnings.push(label("item amounts don't add up to the total"));
    }
  }
  if (totalAmount === 0) totalAmount = null;

  // date (§9.4.5)
  let date = t.date.trim();
  if (!validIsoDate(date)) {
    warnings.push(label(`could not read the date "${t.date}"; using today`));
    date = ctx.today;
  } else if (date > ctx.today) {
    warnings.push(label(`date ${date} is in the future; using today`));
    date = ctx.today;
  } else if (date < addDays(ctx.today, -OLD_DATE_DAYS)) {
    warnings.push(label(`date ${date} is more than ${OLD_DATE_DAYS} days ago`));
  }

  // account: only an explicit ref here; parse.ts fills the fallback (§9.4.6). Unknown ref → null.
  const accountId = t.account_ref === null ? null : (ctx.catalog.accountByRef.get(t.account_ref.trim())?.id ?? null);

  const memoText = t.memo?.replace(/\s+/g, " ").trim() ?? "";
  const draft = {
    payee, payeeId, merchantKind: t.merchant_kind, direction, date,
    accountId, accountExplicit: accountId !== null,
    totalAmount, approximate,
    memo: memoText === "" ? null : clip(memoText),
    lines,
  };
  const checked = IntentDraft.safeParse(draft);
  if (!checked.success) {
    warnings.push(label("could not build a draft for this purchase"));
    return null;
  }
  return checked.data;
}

export function toDrafts(parsed: Parsed, ctx: PostprocessCtx): PostprocessResult {
  const warnings: string[] = [];
  if (parsed.status === "not_a_transaction") {
    return { status: "not_a_transaction", question: null, drafts: [], warnings };
  }
  let txns = parsed.transactions;
  if (txns.length > MAX_DRAFTS) {
    warnings.push(`only the first ${MAX_DRAFTS} purchases were kept`);
    txns = txns.slice(0, MAX_DRAFTS);
  }
  const numbered = txns.length > 1;
  const drafts = txns.flatMap((t, i) => {
    const d = toDraft(t, ctx, warnings, numbered ? i + 1 : 0);
    return d ? [d] : [];
  });
  const question = parsed.clarification_question?.trim() || null;
  if (parsed.status === "needs_clarification") {
    return { status: "needs_clarification", question: question ?? "How much was it?", drafts, warnings };
  }
  if (drafts.length === 0) return { status: "not_a_transaction", question: null, drafts: [], warnings };
  return { status: "ok", question: null, drafts, warnings };
}

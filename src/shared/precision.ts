// src/shared/precision.ts — deterministic precision assessment (DESIGN §9.5, §10.6a). PURE, shared by the Worker
// (postprocess, intent create/patch) and the SPA (live chip on the confirm screen).
//
// Trust boundary: Claude only REPORTS facts (amounts it read, tax, shipping, gift card, shipments). Nothing here
// believes a number because the model said so: an amount counts as exact only when its digits literally appear in
// the user's own text (typed, dictated or pasted), and an order's numbers must reconcile with its grand total.
// Model flags can only downgrade (a hedge, "no cents"), never upgrade. Pasted page text is untrusted: the worst it
// can do is supply numbers that also pass these checks.
import { z } from "zod";
import { minorUnit } from "./money";

/** Upper bound for a note / pasted order page (request validation and the Claude user turn). */
export const MAX_NOTE_CHARS = 20_000;

const M = z.int().nonnegative();

export const OrderShipment = z.object({
  lines: z.array(z.int().min(0).max(19)).max(20),       // 0-based line indexes
  total: M.nullable(),                                  // the shipment's charge, only when the page shows it
});
/** Model-reported order facts, in positive milliunits. Unverified until assessPrecision checks them. */
export const OrderFacts = z.object({
  totalHasCents: z.boolean(),
  lineAmounts: z.array(M.nullable()).max(20),           // snapshot of the line amounts at parse time (edits invalidate shipments)
  lineQuantities: z.array(z.int().min(1).max(99)).max(20),
  itemSubtotal: M.nullable(),
  tax: M.nullable(),
  shipping: M.nullable(),
  discount: M.nullable(),                               // promotions / coupons / free-shipping credits
  giftCard: M.nullable(),                               // gift card / points / store credit applied
  grandTotal: M.nullable(),
  shipments: z.array(OrderShipment).max(10),
  clarityNote: z.string().max(200).nullable(),
});
export type OrderFacts = z.infer<typeof OrderFacts>;

/** What the matcher may rely on for an Amazon order (only built when every number checked out). */
export const OrderPlan = z.object({
  cardTotal: M,                                         // expected sum of all card charges
  tax: M, shipping: M, discount: M,
  shipments: z.array(OrderShipment).nullable(),         // validated partition of the lines, or null
});
export type OrderPlan = z.infer<typeof OrderPlan>;

export const PrecisionLevel = z.enum(["exact", "approximate"]);
export type PrecisionLevel = z.infer<typeof PrecisionLevel>;
/** What drafts and intents carry for display. */
export const PrecisionInfo = z.object({ level: PrecisionLevel, note: z.string().max(300).nullable() });
export type PrecisionInfo = z.infer<typeof PrecisionInfo>;

export const PRECISION_LABEL: Record<PrecisionLevel, string> = {
  exact: "Exact — will auto-match",
  approximate: "Approximate — may ask you",
};

export interface PrecisionResult {
  level: PrecisionLevel;
  totalExact: boolean;
  linesExact: boolean[];
  plan: OrderPlan | null;
  reasons: string[];          // deterministic, user-facing; first one explains a downgrade
  note: string | null;        // the model's clarity note (display only)
}

export interface PrecisionInput {
  merchantKind: string;
  totalAmount: number | null;
  approximate: boolean;
  lines: { amount: number | null; approximate: boolean }[];
  facts?: OrderFacts | null | undefined;
}

export interface StatedAmounts {
  /** Amounts written with explicit minor units ("12.99", "1,234.50"); for 0-decimal currencies every integer. */
  exact: Set<number>;
  /** Plain integers ("2", "Qty: 3") for quantity checks. */
  ints: Set<number>;
}

// A number: thousands-grouped or plain integer part, optional decimal part. Leftmost-longest, so "1,234.56" is
// read whole before "234" could be.
const NUM = /(?<!\d)(\d{1,3}(?:([,.])\d{3})(?:\2\d{3})*|\d+)(?:([.,])(\d+))?(?!\d)/g;

/** Every amount literally written in `text`, in milliunits. */
export function statedAmounts(text: string, decimalDigits: number): StatedAmounts {
  const exact = new Set<number>();
  const ints = new Set<number>();
  for (const m of text.matchAll(NUM)) {
    const intPart = m[1] ?? "";
    const groupSep = m[2];
    const decSep = m[3];
    const dec = m[4];
    if (groupSep !== undefined && decSep === groupSep) continue;      // "1,234,56": not a number we trust
    const whole = Number(intPart.replace(/[,.]/g, ""));
    if (!Number.isSafeInteger(whole) || whole > 1e12) continue;
    if (dec === undefined) {
      ints.add(whole);
      if (decimalDigits === 0) exact.add(whole * 1000);
      continue;
    }
    if (decimalDigits > 0 && dec.length <= decimalDigits) {
      exact.add(whole * 1000 + Number(dec) * 10 ** (3 - dec.length));
    }
  }
  return { exact, ints };
}

const cleanNote = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, 200);
};

/** The deterministic precision of a draft / intent given the user's own text. */
export function assessPrecision(d: PrecisionInput, rawText: string, decimalDigits: number): PrecisionResult {
  const unit = minorUnit(decimalDigits);
  const stated = statedAmounts(rawText, decimalDigits);
  const facts = d.facts ?? null;
  const note = cleanNote(facts?.clarityNote);
  const totalExact = d.totalAmount !== null && d.totalAmount > 0 && !d.approximate
    && (facts?.totalHasCents ?? true) && stated.exact.has(d.totalAmount);
  // A single-line draft carries the order total as its amount (the editor hides the line amount); for an order
  // its item price is the parse-time snapshot.
  const snap0 = facts?.lineAmounts.length === 1 ? facts.lineAmounts[0] : undefined;
  const lines = d.lines.length === 1 && d.lines[0] && snap0 != null && d.lines[0].amount === d.totalAmount && d.merchantKind === "amazon"
    ? [{ ...d.lines[0], amount: snap0 }] : d.lines;
  d = { ...d, lines };
  const snapshotOk = facts !== null && facts.lineAmounts.length === d.lines.length
    && facts.lineAmounts.every((a, k) => a === d.lines[k]?.amount);
  const linesExact = d.lines.map((l, k) => {
    if (l.amount === null || l.amount <= 0 || l.approximate) return false;
    if (stated.exact.has(l.amount)) return true;
    const q = snapshotOk ? (facts?.lineQuantities[k] ?? 1) : 1;      // "2 × 12.99" → 25.98 need not be written
    return q > 1 && stated.ints.has(q) && l.amount % q === 0 && (l.amount / q) % unit === 0 && stated.exact.has(l.amount / q);
  });
  const result = (level: PrecisionLevel, reasons: string[], plan: OrderPlan | null = null): PrecisionResult =>
    ({ level, totalExact, linesExact, plan, reasons, note });

  if (d.merchantKind !== "amazon") {
    if (totalExact) return result("exact", []);
    return result("approximate", [d.approximate ? "The amount is approximate" : "No exact amount with cents in your note"]);
  }

  // ── Amazon: every number must be written in the text and reconcile with the grand total ──
  if (d.lines.length === 0 || !linesExact.every(Boolean)) {
    return result("approximate", ["Some item prices are estimates or not in your text"]);
  }
  type Checked = number | null | "bad";
  const check = (v: number | null | undefined): Checked =>
    v === null || v === undefined ? null : stated.exact.has(v) ? v : v === 0 ? null : "bad";
  const giftCard = check(facts?.giftCard);
  if (giftCard === "bad") return result("approximate", ["Couldn't verify the gift card or points amount"]);
  if (giftCard !== null && giftCard > 0) {
    return result("approximate", ["Gift card or points applied: you'll confirm which charge is which"]);
  }
  const named: [string, Checked][] = [
    ["tax", check(facts?.tax)], ["shipping", check(facts?.shipping)], ["discount", check(facts?.discount)],
    ["item subtotal", check(facts?.itemSubtotal)], ["order total", check(facts?.grandTotal)],
  ];
  for (const [name, v] of named) if (v === "bad") return result("approximate", [`Couldn't find the ${name} in your text`]);
  const num = (k: number): number | null => {
    const v = named[k]?.[1];
    return typeof v === "number" ? v : null;
  };
  const items = d.lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  const subtotal = num(3);
  if (subtotal !== null && Math.abs(subtotal - items) > unit) {
    return result("approximate", ["The items don't add up to the order subtotal"]);
  }
  const grand = num(4) ?? (totalExact ? d.totalAmount : null);
  if (grand === null) return result("approximate", ["Add the order total (with tax) for exact matching"]);
  const shipping = num(1) ?? 0;
  const discount = num(2) ?? 0;
  let tax = num(0);
  if (tax === null) {
    tax = grand - items - shipping + discount;                        // derived from exact numbers only
    if (tax < 0) return result("approximate", ["The amounts don't add up to the order total"]);
  } else if (Math.abs(items + tax + shipping - discount - grand) > 2 * unit) {
    return result("approximate", ["The amounts don't add up to the order total"]);
  }

  // Shipments: a valid partition of the (unedited) lines; a total counts only if written and they all add up.
  let shipments: OrderPlan["shipments"] = null;
  const n = d.lines.length;
  if (snapshotOk && facts && facts.shipments.length > 0) {
    const seen = new Set<number>();
    const valid = facts.shipments.every((s) => s.lines.length > 0 && s.lines.every((k) => {
      if (k < 0 || k >= n || seen.has(k)) return false;
      seen.add(k);
      return true;
    })) && seen.size === n;
    if (valid) {
      shipments = facts.shipments.map((s) => ({ lines: [...s.lines], total: s.total !== null && s.total > 0 && stated.exact.has(s.total) ? s.total : null }));
      const totals = shipments.map((s) => s.total);
      if (totals.every((t) => t !== null)) {
        const sum = totals.reduce<number>((a, t) => a + (t ?? 0), 0);
        if (Math.abs(sum - grand) > unit * shipments.length) shipments = shipments.map((s) => ({ ...s, total: null }));
      }
    }
  }
  // Shipping or a promotion we can't place on a shipment: only the whole order in one charge is predictable.
  if (shipping - discount !== 0 && !(shipments?.every((s) => s.total !== null) ?? false)) {
    shipments = [{ lines: d.lines.map((_, k) => k), total: grand }];
  }
  return result("exact", [], { cardTotal: grand, tax, shipping, discount, shipments });
}

export function precisionInfo(r: PrecisionResult): PrecisionInfo {
  return { level: r.level, note: r.reasons[0] ?? r.note };
}

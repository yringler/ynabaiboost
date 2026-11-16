// domain/exact.ts — DESIGN §10.6a. PURE. Precision-aware Amazon matching: when the user's order facts were verified
// (shared/precision.ts → OrderPlan), predict what each line or shipment will charge to the card and look for the
// ONE way the candidate charges can be explained. Anything less than a unique, consistent explanation is left to
// the ranked review of §10.6.
import { minorUnit } from "../../shared/money";
import { MAX_CHARGES, MAX_LINES, MAX_SOLUTIONS } from "./subsets";
import type { DIntent, DLine, DTxn } from "./types";

/** Lines that are charged together, with the predicted charge and its tolerance (milliunits). */
export interface ExactGroup { lines: DLine[]; predicted: number; tol: number }
export interface ExactPart { txn: DTxn; lines: DLine[] }
export type ExactOutcome =
  | { kind: "auto"; parts: ExactPart[]; complete: boolean }
  | { kind: "none" }
  | { kind: "ambiguous"; reason: string };

/** Largest-remainder split of `total` (a multiple of `unit`) by `weights`, in whole minor units. Exact sum. */
export function shareByWeight(total: number, weights: number[], unit: number): number[] {
  if (weights.length === 0) return [];
  const n = Math.floor(total / unit);
  const leftover = total - n * unit;
  const W = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const parts = weights.map((w, k) => {
    if (W === 0) return { k, w, floor: k === 0 ? BigInt(n) : 0n, rem: 0n };
    const num = BigInt(n) * BigInt(Math.max(0, w));
    return { k, w, floor: num / BigInt(W), rem: num % BigInt(W) };
  });
  let given = parts.reduce((s, p) => s + p.floor, 0n);
  const order = [...parts].sort((a, b) => (a.rem !== b.rem ? (b.rem > a.rem ? 1 : -1) : b.w - a.w || a.k - b.k));
  for (let j = 0; given < BigInt(n) && order.length > 0; j = (j + 1) % order.length) {
    const p = order[j];
    if (!p) break;
    p.floor += 1n;
    given += 1n;
  }
  const out = parts.map((p) => Number(p.floor) * unit);
  if (leftover !== 0) out[0] = (out[0] ?? 0) + leftover;
  return out;
}

/** Open charge groups of an intent with a verified order plan, or null when the plan can't predict them.
 *  Tax is allocated to items in proportion to their prices (largest remainder, whole minor units); a shipment
 *  whose charge the page showed is predicted by that number. Tolerance: one minor unit per item (per-item tax
 *  rounding), one for a shown shipment total. */
export function predictGroups(i: Pick<DIntent, "lines" | "order">, decimalDigits: number): ExactGroup[] | null {
  const plan = i.order;
  if (!plan) return null;
  const unit = minorUnit(decimalDigits);
  const lines = i.lines;
  if (lines.length === 1) {
    // A one-item order is the whole card total (its stored amount may be the total or the item price).
    return lines[0]?.status === "open" ? [{ lines: [lines[0]], predicted: plan.cardTotal, tol: unit }] : [];
  }
  const shares = shareByWeight(plan.tax, lines.map((l) => l.amount), unit);
  const cost = lines.map((l, k) => l.amount + (shares[k] ?? 0));
  const isOpen = (k: number) => lines[k]?.status === "open";
  const single = (k: number): ExactGroup => ({ lines: [lines[k] as DLine], predicted: cost[k] ?? 0, tol: unit });
  const groups: ExactGroup[] = [];
  if (plan.shipments) {
    const seen = new Set<number>();
    for (const s of plan.shipments) {
      for (const k of s.lines) {
        if (k < 0 || k >= lines.length || seen.has(k)) return null;
        seen.add(k);
      }
    }
    if (seen.size !== lines.length) return null;
    const unplaced = plan.shipping - plan.discount !== 0;
    for (const s of plan.shipments) {
      if (s.lines.every(isOpen)) {
        const predicted = s.total ?? s.lines.reduce((a, k) => a + (cost[k] ?? 0), 0);
        groups.push({ lines: s.lines.map((k) => lines[k] as DLine), predicted, tol: s.total !== null ? unit : s.lines.length * unit });
      } else if (s.lines.some(isOpen)) {
        if (unplaced) return null;                     // shipping/promo of a half-matched shipment: unknown
        for (const k of s.lines) if (isOpen(k)) groups.push(single(k));
      }
    }
    return groups;
  }
  lines.forEach((_, k) => {
    if (isOpen(k)) groups.push(single(k));
  });
  return groups;
}

/** Lowest and highest single charge the groups can explain. */
export function exactRange(groups: ExactGroup[]): { lo: number; hi: number } {
  if (groups.length === 0) return { lo: 1, hi: 0 };
  return {
    lo: Math.min(...groups.map((g) => g.predicted - g.tol)),
    hi: groups.reduce((s, g) => s + g.predicted + g.tol, 0),
  };
}

/** Does `charge` equal some combination of the groups within tolerance? (Also used for "fits another order".) */
export function exactFitsAny(charge: number, groups: ExactGroup[]): boolean {
  const g = Math.min(groups.length, MAX_LINES);
  for (let mask = 1; mask < 1 << g; mask++) {
    let p = 0;
    let t = 0;
    for (let b = 0; b < g; b++) {
      if (mask & (1 << b)) {
        p += groups[b]?.predicted ?? 0;
        t += groups[b]?.tol ?? 0;
      }
    }
    if (Math.abs(charge - p) <= t) return true;
  }
  return false;
}

/** Category outcome of putting `lines` on charge k: the split depends only on category weights. */
function outcomeKey(k: number, lines: DLine[]): string {
  const w = new Map<string, number>();
  for (const l of lines) w.set(l.categoryId, (w.get(l.categoryId) ?? 0) + l.amount);
  return `${k}|${[...w.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([c, a]) => `${c}:${a}`).join(",")}`;
}

/**
 * The §10.6a rule. V = every non-empty assignment of disjoint groups to distinct charges in which each used
 * charge equals its groups' predicted sum within their summed tolerance. Auto-resolve only when
 *   1. V is complete (no cap hit) and non-empty,
 *   2. every charge appearing in V has exactly ONE category outcome across V (identical-price items in the same
 *      category are interchangeable; in different categories they are not),
 *   3. one assignment A* in V uses every such charge (they don't compete for the same items), and
 *   4. if A* covers every line of a fresh order, its charges add up to the order's card total (± a minor unit
 *      per charge).
 * A* may leave groups uncovered (a partly shipped order): those lines stay open and the intent goes partial.
 */
export function solveExact(i: Pick<DIntent, "lines" | "order">, groups: ExactGroup[], charges: DTxn[], decimalDigits: number): ExactOutcome {
  if (groups.length === 0 || charges.length === 0) return { kind: "none" };
  if (groups.length > MAX_LINES) return { kind: "ambiguous", reason: "too many items" };
  if (charges.length > MAX_CHARGES) return { kind: "ambiguous", reason: "too many candidate charges" };
  const unit = minorUnit(decimalDigits);
  const g = groups.length;
  const size = 1 << g;
  const pSum = new Array<number>(size).fill(0);
  const tSum = new Array<number>(size).fill(0);
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    const b = 31 - Math.clz32(low);
    pSum[mask] = (pSum[mask ^ low] ?? 0) + (groups[b]?.predicted ?? 0);
    tSum[mask] = (tSum[mask ^ low] ?? 0) + (groups[b]?.tol ?? 0);
  }
  const linesOf = (mask: number): DLine[] => groups.flatMap((gr, b) => (mask & (1 << b) ? gr.lines : []));
  const fitting = charges.map((c) => {
    const abs = Math.abs(c.amount);
    const out: number[] = [];
    for (let mask = 1; mask < size; mask++) if (Math.abs(abs - (pSum[mask] ?? 0)) <= (tSum[mask] ?? 0)) out.push(mask);
    return out;
  });
  if (fitting.reduce((s, f) => s + f.length, 0) > MAX_SOLUTIONS) return { kind: "ambiguous", reason: "too many combinations" };
  if (fitting.every((f) => f.length === 0)) return { kind: "none" };

  const V: [number, number][][] = [];
  let overflow = false;
  const pairs: [number, number][] = [];
  const dfs = (k: number, used: number): void => {
    if (overflow) return;
    if (k === charges.length) {
      if (pairs.length > 0) {
        V.push([...pairs]);
        if (V.length > MAX_SOLUTIONS) overflow = true;
      }
      return;
    }
    dfs(k + 1, used);
    for (const mask of fitting[k] ?? []) {
      if ((mask & used) !== 0) continue;
      pairs.push([k, mask]);
      dfs(k + 1, used | mask);
      pairs.pop();
    }
  };
  dfs(0, 0);
  if (overflow) return { kind: "ambiguous", reason: "too many combinations" };
  if (V.length === 0) return { kind: "none" };

  const keys = new Map<number, Set<string>>();
  for (const a of V) {
    for (const [k, mask] of a) {
      const set = keys.get(k) ?? new Set<string>();
      set.add(outcomeKey(k, linesOf(mask)));
      keys.set(k, set);
    }
  }
  if ([...keys.values()].some((s) => s.size > 1)) return { kind: "ambiguous", reason: "a charge fits different items" };
  const best = V.find((a) => a.length === keys.size);
  if (!best) return { kind: "ambiguous", reason: "charges compete for the same items" };

  const covered = best.reduce((m, [, mask]) => m | mask, 0);
  const complete = covered === size - 1;
  if (complete && i.lines.every((l) => l.status === "open") && i.order) {
    const sum = best.reduce((s, [k]) => s + Math.abs(charges[k]?.amount ?? 0), 0);
    if (Math.abs(sum - i.order.cardTotal) > unit * best.length) return { kind: "ambiguous", reason: "charges don't add up to the order total" };
  }
  const parts = best
    .map(([k, mask]) => ({ txn: charges[k] as DTxn, lines: linesOf(mask) }))
    .sort((a, b) => a.txn.date.localeCompare(b.txn.date) || a.txn.id.localeCompare(b.txn.id));
  return { kind: "auto", parts, complete };
}

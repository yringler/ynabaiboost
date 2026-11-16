// domain/allocate.ts — WP5 (DESIGN §10.8). PURE. Largest-remainder allocation of a charge across categories.
import { minorUnit, type Direction } from "../../shared/money";
import type { Allocation } from "../../shared/schemas";

export interface AllocLine { categoryId: string; amount: number; description: string }

const MEMO_MAX = 100;

/** Splits `chargeAbs` (positive milliunits) across the lines' categories in proportion to their amounts.
 *  Every amount is a multiple of the currency's minor unit and the signed sum equals the signed charge exactly. */
export function allocate(chargeAbs: number, lines: AllocLine[], direction: Direction, decimals: number): Allocation[] {
  const groups: { categoryId: string; weight: number; descriptions: string[] }[] = [];
  for (const l of lines) {
    let g = groups.find((x) => x.categoryId === l.categoryId);
    if (!g) {
      g = { categoryId: l.categoryId, weight: 0, descriptions: [] };
      groups.push(g);
    }
    g.weight += Math.max(0, l.amount);
    if (l.description) g.descriptions.push(l.description);
  }
  if (groups.length === 0) return [];

  const unit = minorUnit(decimals);
  const n = Math.floor(chargeAbs / unit);
  const leftover = chargeAbs - n * unit; // 0 for real charges; kept exact for odd inputs
  const total = groups.reduce((s, g) => s + g.weight, 0);
  const W = BigInt(total);
  const N = BigInt(n);

  const parts = groups.map((g, i) => {
    if (total === 0) return { i, g, floor: i === 0 ? N : 0n, rem: 0n };
    const num = N * BigInt(g.weight);
    return { i, g, floor: num / W, rem: num % W };
  });
  let given = parts.reduce((s, p) => s + p.floor, 0n);
  const order = [...parts].sort((a, b) =>
    a.rem !== b.rem ? (b.rem > a.rem ? 1 : -1)
      : a.g.weight !== b.g.weight ? b.g.weight - a.g.weight
        : a.g.categoryId < b.g.categoryId ? -1 : a.g.categoryId > b.g.categoryId ? 1 : 0);
  for (let k = 0; given < N; k = (k + 1) % order.length) {
    const p = order[k];
    if (!p) break;
    p.floor += 1n;
    given += 1n;
  }
  // Leftover sub-unit milliunits (never for real charges) go to the largest group.
  const largest = [...parts].sort((a, b) => b.g.weight - a.g.weight)[0];

  const sign = direction === "outflow" ? -1 : 1;
  return parts.map((p) => {
    const abs = Number(p.floor) * unit + (p === largest ? leftover : 0);
    const memo = p.g.descriptions.length ? truncateMemo(p.g.descriptions.join(", ")) : null;
    return { categoryId: p.g.categoryId, amount: abs === 0 ? 0 : sign * abs, memo };
  });
}

function truncateMemo(s: string): string {
  return s.length <= MEMO_MAX ? s : `${s.slice(0, MEMO_MAX - 1).trimEnd()}…`;
}

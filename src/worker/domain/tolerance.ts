// domain/tolerance.ts — WP5 (DESIGN §10.2). PURE.

/** Roundness steps in currency units, largest first. */
const STEPS = [100, 50, 25, 10, 5, 1] as const;

/** Roundness step in milliunits (0 when the amount has cents). `a` is a positive milliunit amount. */
export function roundnessUnit(a: number): number {
  if (a % 1000 !== 0) return 0;
  for (const s of STEPS) if (a % (s * 1000) === 0) return s * 1000;
  return 1000;
}

/** Tolerance in milliunits for an amount the user said (DESIGN §10.2 table). */
export function computeTolerance(a: number, approximate: boolean): number {
  const u = roundnessUnit(a);
  if (!approximate) return u === 0 ? Math.max(500, Math.round(0.01 * a)) : Math.max(1000, Math.round(0.02 * a));
  const tol = Math.max(u / 2, Math.round(0.05 * a), 1000);
  return Math.min(tol, Math.round(0.35 * a));
}

/** Tolerance for an amount the user wrote with its exact minor units (DESIGN §10.2, §9.5): one minor unit. */
export function exactTolerance(decimalDigits: number): number {
  return 10 ** Math.max(0, 3 - decimalDigits);
}

/** The intent/line tolerance: tight for verified exact amounts, roundness-based otherwise. */
export function toleranceFor(a: number, approximate: boolean, exact: boolean, decimalDigits: number): number {
  return exact && !approximate ? exactTolerance(decimalDigits) : computeTolerance(a, approximate);
}

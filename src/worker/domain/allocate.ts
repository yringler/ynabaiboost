// domain/allocate.ts — WP5 (DESIGN §10.8). PURE. Stub created by WP1; signatures are WP5-internal (not frozen).
import type { Direction } from "../../shared/money";
import type { Allocation } from "../../shared/schemas";

export function allocate(
  _chargeAbs: number,
  _lines: { categoryId: string; amount: number; description: string }[],
  _direction: Direction,
  _decimals: number,
): Allocation[] {
  throw new Error("not implemented: allocate");
}

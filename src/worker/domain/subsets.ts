// domain/subsets.ts — WP5 (DESIGN §10.6). PURE. Stub created by WP1; signatures are WP5-internal (not frozen).
import type { ReviewOption } from "../../shared/schemas";
import type { DIntent, DLine, DTxn, ReconcileInput } from "./types";

export function fits(_charge: number, _lines: DLine[], _maxTaxRate: number): boolean {
  throw new Error("not implemented: fits");
}
export function enumerateAssignments(_intent: DIntent, _charges: DTxn[], _input: ReconcileInput): Omit<ReviewOption, "label">[] {
  throw new Error("not implemented: enumerateAssignments");
}

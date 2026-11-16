// domain/score.ts — WP5 (DESIGN §10.5). PURE. Stub created by WP1; signatures are WP5-internal (not frozen).
import type { DIntent, DTxn, ReconcileInput } from "./types";

/** §10.5 score, or null when the txn fails the candidate filter. */
export function scoreCandidate(_intent: DIntent, _txn: DTxn, _input: ReconcileInput): number | null {
  throw new Error("not implemented: scoreCandidate");
}

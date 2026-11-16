// engine/apply.ts — WP5 (DESIGN §8.5, §10.9). Stub created by WP1.
import type { Allocation } from "../../shared/schemas";
import type { EngineCtx } from "./reconcile";

export type MatchKind = "ynab_auto" | "single" | "split" | "amazon_subset" | "manual" | "review";
export async function applyMatch(_ctx: EngineCtx, _m: {
  intentId: string; txnId: string; lineIds: string[]; allocation: Allocation[]; score: number | null; kind: MatchKind;
}): Promise<void> {
  throw new Error("not implemented: applyMatch");
}

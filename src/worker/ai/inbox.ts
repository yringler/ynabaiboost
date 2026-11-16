// ai/inbox.ts — WP4 (DESIGN §8.4, §9.5). Stub created by WP1.
import type { InboxItem } from "../../shared/schemas";
import type { DB } from "../env";
import type { AiCtx } from "./parse";

/** Uses WP5 excludedTxnIds and WP5 possibleIntentFor (§9.5). */
export async function listInbox(_ctx: AiCtx): Promise<InboxItem[]> {
  throw new Error("not implemented: listInbox");
}
export async function countInbox(_db: DB, _userId: string, _planId: string): Promise<number> {
  throw new Error("not implemented: countInbox");
}
/** Fills inbox_suggestions for inbox txns lacking one. Returns #suggested. Silently returns 0 when no key/consent. */
export async function suggestInboxCategories(_ctx: AiCtx, _opts: { max: number; effort: "low" | "medium" }): Promise<number> {
  throw new Error("not implemented: suggestInboxCategories");
}

// jobs/cycle.ts — WP3 (DESIGN §8.3, §10.11). Stub created by WP1.
import type { SyncResult } from "../../shared/schemas";
import type { DB } from "../env";

export type CycleTrigger = "cron" | "manual" | "intent_create";
export async function runUserCycle(_env: Env, _userId: string, _trigger: CycleTrigger): Promise<SyncResult> {
  throw new Error("not implemented: runUserCycle");
}
export async function runCron(_env: Env): Promise<void> {
  throw new Error("not implemented: runCron");
}
/** Acquire sync_state.lock_until (120 s) for (user, plan), run fn, release. If held, poll every 250 ms up to
 *  `waitMs` (default 0) and return "locked" if still held. Used by runUserCycle and POST /api/intents. */
export async function withUserLock<T>(_env: Env, _db: DB, _userId: string, _planId: string, _fn: () => Promise<T>, _waitMs?: number): Promise<T | "locked"> {
  throw new Error("not implemented: withUserLock");
}

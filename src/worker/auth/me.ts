// auth/me.ts — WP2: assembles the `Me` payload for GET /api/me and POST /auth/pat (DESIGN §7).
import { and, eq } from "drizzle-orm";
import { todayIn } from "../../shared/dates";
import { Me } from "../../shared/schemas";
import { syncState } from "../db/schema";
import { countOpen } from "../engine/reconcile";
import type { DB, UserRow } from "../env";
import { oauthAvailable } from "./oauth";
import { hasSecret } from "./secrets";
import { getSettings } from "./settings";
import { isAdmin } from "./users";

const safeToday = (tz: string): string => {
  try {
    return todayIn(tz);
  } catch {
    return todayIn("UTC");
  }
};

/** Counts must never take /api/me down (the SPA cannot start without it): failures are logged and read as 0. */
async function safeCount<T>(label: string, userId: string, f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    console.error(JSON.stringify({ msg: "me_count_failed", count: label, userId, error: e instanceof Error ? e.message : String(e) }));
    return fallback;
  }
}

export async function buildMe(env: Env, db: DB, user: UserRow): Promise<Me> {
  const userId = user.id;
  const [settings, hasAnthropicKey] = await Promise.all([getSettings(db, userId), hasSecret(db, userId, "anthropic")]);
  const planId = settings.planId;

  let plan: Me["plan"] = null;
  let lastSyncError: string | null = null;
  let lastSyncAt: number | null = null;
  let counts: Me["counts"] = { pending: 0, stale: 0, review: 0 };

  if (planId !== null) {
    const st = await db.select().from(syncState).where(and(eq(syncState.userId, userId), eq(syncState.planId, planId))).get();
    // Before the first sync of a newly chosen plan there is no sync_state row yet: report the plan with defaults.
    plan = {
      id: planId,
      name: st?.planName ?? "",
      currency: { isoCode: st?.currencyIso ?? "USD", decimalDigits: st?.currencyDecimals ?? 2 },
    };
    lastSyncError = st?.lastError ?? null;
    lastSyncAt = st?.lastCycleAt ?? null;
    const today = safeToday(settings.timezone);
    counts = await safeCount("open", userId, () => countOpen(db, userId, planId, today), { pending: 0, stale: 0, review: 0 });
  }

  return Me.parse({
    userId,
    isAdmin: isAdmin(env, userId),
    authType: user.authType,
    needsReauth: user.needsReauth,
    sttAllowed: user.sttAllowed,
    hasAnthropicKey,
    oauthAvailable: oauthAvailable(env),
    settings,
    plan,
    counts,
    lastSyncError,
    lastSyncAt,
  });
}

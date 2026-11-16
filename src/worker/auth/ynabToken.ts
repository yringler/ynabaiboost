// auth/ynabToken.ts — WP2 (DESIGN §8.2, §12 WP2 "Token refresh").
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { users } from "../db/schema";
import type { BatchItem, DB } from "../env";
import { AppError } from "../lib/errors";
import { isInvalidGrant, refreshTokens } from "./oauth";
import { getSecret, putSealedStmt, sealSecret } from "./secrets";
import { getUser } from "./users";

export const REFRESH_MARGIN_MS = 5 * 60 * 1000;   // refresh when < 5 min left
export const REFRESH_LOCK_MS = 30 * 1000;         // users.token_refresh_lock_until = now + 30 s
export const LOCK_POLL_MS = 500;                  // waiter re-reads ynab_access every 500 ms …
export const LOCK_POLL_TRIES = 10;                // … up to 10 times

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reauth = () => new AppError("ynab_reauth_required", "Sign in to YNAB again");

const isFresh = (s: { expiresAt: number | null } | null, now: number): s is { value: string; expiresAt: number | null } =>
  s !== null && (s.expiresAt === null || s.expiresAt - now > REFRESH_MARGIN_MS);

/** Valid bearer token for YNAB API calls. PAT: returned as is. OAuth: refreshes if < 5 min left,
 *  serialised via users.token_refresh_lock_until. On invalid_grant/401 sets needs_reauth=1 and throws
 *  AppError('ynab_reauth_required'). */
export async function getYnabAccessToken(env: Env, db: DB, userId: string): Promise<string> {
  const user = await getUser(db, userId);
  if (!user) throw new AppError("unauthenticated", "Unknown user");

  if (user.authType === "pat") {
    const pat = await getSecret(env, db, userId, "ynab_pat");
    if (!pat) {
      await markNeedsReauth(db, userId);
      throw reauth();
    }
    return pat.value;
  }

  if (user.needsReauth) throw reauth();
  const access = await getSecret(env, db, userId, "ynab_access");
  if (isFresh(access, Date.now())) return access.value;

  if (!(await acquireLock(db, userId))) {
    // Someone else is refreshing: wait for their result.
    for (let i = 0; i < LOCK_POLL_TRIES; i++) {
      await sleep(LOCK_POLL_MS);
      const again = await getSecret(env, db, userId, "ynab_access");
      if (isFresh(again, Date.now())) return again.value;
      const u = await getUser(db, userId);
      if (!u || u.needsReauth) throw reauth();
    }
    throw new AppError("ynab_error", "YNAB sign-in refresh is taking too long. Try again in a minute.");
  }

  let released = false;
  try {
    // Another request may have finished a refresh between our read and taking the lock.
    const again = await getSecret(env, db, userId, "ynab_access");
    if (isFresh(again, Date.now())) return again.value;

    const refresh = await getSecret(env, db, userId, "ynab_refresh");
    if (!refresh) {
      await markNeedsReauth(db, userId);
      throw reauth();
    }
    let tokens;
    try {
      tokens = await refreshTokens(env, refresh.value);
    } catch (e) {
      if (isInvalidGrant(e)) {
        await markNeedsReauth(db, userId);
        throw reauth();
      }
      throw new AppError("ynab_error", "Could not refresh the YNAB sign-in", e);
    }
    // Store both tokens (refresh tokens are treated as rotating, single-use) and release the lock atomically.
    const now = Date.now();
    const stmts: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
      putSealedStmt(db, userId, "ynab_access", await sealSecret(env, userId, "ynab_access", tokens.accessToken), tokens.expiresAt, now),
      putSealedStmt(db, userId, "ynab_refresh", await sealSecret(env, userId, "ynab_refresh", tokens.refreshToken ?? refresh.value), null, now),
      db.update(users).set({ tokenRefreshLockUntil: null }).where(eq(users.id, userId)),
    ];
    await db.batch(stmts);
    released = true;
    return tokens.accessToken;
  } finally {
    if (!released) await db.update(users).set({ tokenRefreshLockUntil: null }).where(eq(users.id, userId));
  }
}

/** WP2-internal: UPDATE users SET token_refresh_lock_until=now+30s WHERE id=? AND (lock IS NULL OR lock < now). */
export async function acquireLock(db: DB, userId: string, now: number = Date.now()): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ tokenRefreshLockUntil: now + REFRESH_LOCK_MS })
    .where(and(eq(users.id, userId), or(isNull(users.tokenRefreshLockUntil), lt(users.tokenRefreshLockUntil, now))))
    .returning({ id: users.id });
  return rows.length > 0;
}

export async function markNeedsReauth(db: DB, userId: string): Promise<void> {
  await db.update(users).set({ needsReauth: true }).where(eq(users.id, userId));
}

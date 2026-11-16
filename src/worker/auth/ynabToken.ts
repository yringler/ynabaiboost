// auth/ynabToken.ts — WP2 (DESIGN §8.2). Stub created by WP1.
import type { DB } from "../env";

/** Valid bearer token for YNAB API calls. PAT: returned as is. OAuth: refreshes if < 5 min left,
 *  serialised via users.token_refresh_lock_until. On invalid_grant/401 sets needs_reauth=1 and throws
 *  AppError('ynab_reauth_required'). */
export async function getYnabAccessToken(_env: Env, _db: DB, _userId: string): Promise<string> {
  throw new Error("not implemented: getYnabAccessToken");
}
export async function markNeedsReauth(_db: DB, _userId: string): Promise<void> {
  throw new Error("not implemented: markNeedsReauth");
}

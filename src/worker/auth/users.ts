// auth/users.ts — WP2 (DESIGN §8.2, D16). Access is decided by vars, not by a DB status.
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import type { DB, UserRow } from "../env";
import { deleteSecretsStmt, type SecretKind } from "./secrets";

/** Parses a comma-separated id list var ("a, b,,c" → {a,b,c}). */
export function parseIdList(v: string | undefined): Set<string> {
  return new Set((v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
}

/** ADMIN_USER_IDS */
export function isAdmin(env: Env, userId: string): boolean {
  return userId !== "" && parseIdList(env.ADMIN_USER_IDS).has(userId);
}

/** admin, or in ALLOWED_USER_IDS, or ALLOWED_USER_IDS = "*" */
export function isAllowed(env: Env, userId: string): boolean {
  if (userId === "") return false;
  if (isAdmin(env, userId)) return true;
  const allowed = parseIdList(env.ALLOWED_USER_IDS);
  return allowed.has("*") || allowed.has(userId);
}

/** YNAB secrets that belong to the *other* auth type; dropped when a user re-logs in with a different type. */
const STALE_SECRETS: Record<"oauth" | "pat", SecretKind[]> = {
  oauth: ["ynab_pat"],
  pat: ["ynab_access", "ynab_refresh"],
};

/** Callers check isAllowed first. Creates the user or records a fresh login: sets auth_type, clears
 *  needs_reauth and any stale refresh lock, bumps last_seen_at, and deletes the other auth type's secrets.
 *  The caller stores the new YNAB secret(s) afterwards. */
export async function upsertUser(_env: Env, db: DB, userId: string, authType: "oauth" | "pat"): Promise<UserRow> {
  const now = Date.now();
  const [, rows] = await db.batch([
    deleteSecretsStmt(db, userId, STALE_SECRETS[authType]),
    db
      .insert(users)
      .values({ id: userId, authType, sttAllowed: false, needsReauth: false, tokenRefreshLockUntil: null, createdAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: users.id, set: { authType, needsReauth: false, tokenRefreshLockUntil: null, lastSeenAt: now } })
      .returning(),
  ]);
  const row = rows[0];
  if (!row) throw new Error("upsertUser: no row returned");
  return row;
}

export async function getUser(db: DB, userId: string): Promise<UserRow | null> {
  return (await db.select().from(users).where(eq(users.id, userId)).get()) ?? null;
}

// auth/users.ts — WP2 (DESIGN §8.2). Stub created by WP1.
import type { DB, UserRow } from "../env";

/** ADMIN_USER_IDS */
export function isAdmin(_env: Env, _userId: string): boolean {
  throw new Error("not implemented: isAdmin");
}
/** admin, or in ALLOWED_USER_IDS, or ALLOWED_USER_IDS = "*" */
export function isAllowed(_env: Env, _userId: string): boolean {
  throw new Error("not implemented: isAllowed");
}
/** Callers check isAllowed first. */
export async function upsertUser(_env: Env, _db: DB, _userId: string, _authType: "oauth" | "pat"): Promise<UserRow> {
  throw new Error("not implemented: upsertUser");
}
export async function getUser(_db: DB, _userId: string): Promise<UserRow | null> {
  throw new Error("not implemented: getUser");
}

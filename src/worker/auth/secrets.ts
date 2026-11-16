// auth/secrets.ts — WP2 (DESIGN §8.2, D7). Encrypted per-user secrets in user_secrets.
import { and, eq, inArray } from "drizzle-orm";
import { userSecrets } from "../db/schema";
import type { BatchItem, DB } from "../env";
import { open, seal } from "./crypto";

export type SecretKind = "ynab_access" | "ynab_refresh" | "ynab_pat" | "anthropic";

const aadFor = (userId: string, kind: SecretKind) => `${userId}:${kind}`;

/** WP2-internal: encrypts a secret value for the given row (AAD = `userId:kind`). */
export function sealSecret(env: Env, userId: string, kind: SecretKind, value: string): Promise<string> {
  return seal(env, value, aadFor(userId, kind));
}

/** WP2-internal: an un-awaited upsert of an already sealed value, so callers can store several secrets
 *  atomically in one db.batch. (Kept synchronous: an async function would execute the thenable query.) */
export function putSealedStmt(
  db: DB, userId: string, kind: SecretKind, sealed: string, expiresAt: number | null = null, now: number = Date.now(),
): BatchItem<"sqlite"> {
  return db
    .insert(userSecrets)
    .values({ userId, kind, sealed, expiresAt, updatedAt: now })
    .onConflictDoUpdate({ target: [userSecrets.userId, userSecrets.kind], set: { sealed, expiresAt, updatedAt: now } });
}

export async function putSecret(env: Env, db: DB, userId: string, kind: SecretKind, value: string, expiresAt?: number | null): Promise<void> {
  await putSealedStmt(db, userId, kind, await sealSecret(env, userId, kind, value), expiresAt ?? null);
}

export async function getSecret(env: Env, db: DB, userId: string, kind: SecretKind): Promise<{ value: string; expiresAt: number | null } | null> {
  const row = await db
    .select({ sealed: userSecrets.sealed, expiresAt: userSecrets.expiresAt })
    .from(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.kind, kind)))
    .get();
  if (!row) return null;
  return { value: await open(env, row.sealed, aadFor(userId, kind)), expiresAt: row.expiresAt };
}

/** WP2-internal: whether a secret row exists, without decrypting it. */
export async function hasSecret(db: DB, userId: string, kind: SecretKind): Promise<boolean> {
  const row = await db
    .select({ kind: userSecrets.kind })
    .from(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.kind, kind)))
    .get();
  return row !== undefined;
}

/** WP2-internal: un-awaited delete for db.batch. No kinds = every secret of the user. */
export function deleteSecretsStmt(db: DB, userId: string, kinds?: SecretKind[]): BatchItem<"sqlite"> {
  const where = kinds === undefined
    ? eq(userSecrets.userId, userId)
    : and(eq(userSecrets.userId, userId), inArray(userSecrets.kind, kinds));
  return db.delete(userSecrets).where(where);
}

export async function deleteSecrets(db: DB, userId: string, kinds?: SecretKind[]): Promise<void> {
  if (kinds !== undefined && kinds.length === 0) return;
  await deleteSecretsStmt(db, userId, kinds);
}

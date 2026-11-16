// auth/secrets.ts — WP2 (DESIGN §8.2). Stub created by WP1.
import type { DB } from "../env";

export type SecretKind = "ynab_access" | "ynab_refresh" | "ynab_pat" | "anthropic";
export async function putSecret(_env: Env, _db: DB, _userId: string, _kind: SecretKind, _value: string, _expiresAt?: number | null): Promise<void> {
  throw new Error("not implemented: putSecret");
}
export async function getSecret(_env: Env, _db: DB, _userId: string, _kind: SecretKind): Promise<{ value: string; expiresAt: number | null } | null> {
  throw new Error("not implemented: getSecret");
}
export async function deleteSecrets(_db: DB, _userId: string, _kinds?: SecretKind[]): Promise<void> {
  throw new Error("not implemented: deleteSecrets");
}

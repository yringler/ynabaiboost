// auth/crypto.ts — WP2 (DESIGN §8.2). Stub created by WP1.
export async function seal(_env: Env, _plaintext: string, _aad: string): Promise<string> {
  throw new Error("not implemented: seal");
}
/** Throws AppError('internal') on tamper. */
export async function open(_env: Env, _sealed: string, _aad: string): Promise<string> {
  throw new Error("not implemented: open");
}

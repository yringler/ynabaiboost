// auth/anthropicKey.ts — WP2 (DESIGN §8.2). Stub created by WP1.
import type { DB } from "../env";

/** Throws AppError('ai_consent_required') unless settings.aiDataConsent, AppError('anthropic_key_missing') if unset. */
export async function getAnthropicKey(_env: Env, _db: DB, _userId: string): Promise<string> {
  throw new Error("not implemented: getAnthropicKey");
}

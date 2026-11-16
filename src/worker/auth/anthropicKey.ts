// auth/anthropicKey.ts — WP2 (DESIGN §8.2, D19).
import type { DB } from "../env";
import { AppError } from "../lib/errors";
import { getSecret } from "./secrets";
import { getSettings } from "./settings";

/** Throws AppError('ai_consent_required') unless settings.aiDataConsent, AppError('anthropic_key_missing') if unset. */
export async function getAnthropicKey(env: Env, db: DB, userId: string): Promise<string> {
  const settings = await getSettings(db, userId);
  if (!settings.aiDataConsent) throw new AppError("ai_consent_required", "Allow sending data to Anthropic in Settings first");
  const secret = await getSecret(env, db, userId, "anthropic");
  if (!secret) throw new AppError("anthropic_key_missing", "Add your Anthropic API key in Settings");
  return secret.value;
}

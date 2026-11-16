// routes/account.ts — WP2 (DESIGN §7): /api/me, /api/settings, /api/secrets/anthropic, /api/account.
// Mounted at /api behind requireSession + requireAllowedUser (index.ts). No router-wide `use` here:
// this router shares the /api prefix with other packages' routers.
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { AnthropicKeyReq } from "../../shared/api";
import { Me, SettingsPatch, SettingsShape } from "../../shared/schemas";
import { buildMe } from "../auth/me";
import { deleteSecretsStmt, putSealedStmt, sealSecret } from "../auth/secrets";
import { destroySession } from "../auth/sessions";
import { getSettings, updateSettings } from "../auth/settings";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validate";
import { requireJson } from "../middleware/requireJson";

const ok = { ok: true as const };
export const ANTHROPIC_CHECK_MODEL = "claude-sonnet-5-5";

/** Checks an Anthropic key with a free countTokens call (DESIGN §12 WP2). */
export async function checkAnthropicKey(apiKey: string): Promise<void> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 });
  try {
    await client.messages.countTokens({ model: ANTHROPIC_CHECK_MODEL, messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new AppError("anthropic_key_invalid", "Anthropic rejected this API key");
    }
    if (e instanceof Anthropic.APIError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) {
      throw new AppError("anthropic_key_invalid", `Anthropic could not use this API key (HTTP ${e.status})`);
    }
    throw new AppError("ai_unavailable", "Could not reach Anthropic to check the key. Try again later.");
  }
}

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get("/me", async (c) => c.json(Me.parse(await buildMe(c.env, c.var.db, c.var.user))));

accountRoutes.get("/settings", async (c) => c.json(SettingsShape.parse(await getSettings(c.var.db, c.var.userId))));

accountRoutes.patch("/settings", requireJson, validate("json", SettingsPatch), async (c) => {
  const patch = c.req.valid("json");
  const db = c.var.db;
  const userId = c.var.userId;
  const before = await getSettings(db, userId);
  const next = await updateSettings(db, userId, patch);
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  if (changed.length > 0) {
    await auditStmt(db, { userId, actor: "user", action: "settings_changed", summary: `Settings changed: ${changed.join(", ")}` });
  }
  return c.json(SettingsShape.parse(next));
});

accountRoutes.put("/secrets/anthropic", requireJson, validate("json", AnthropicKeyReq), async (c) => {
  const { apiKey } = c.req.valid("json");
  await checkAnthropicKey(apiKey);
  const db = c.var.db;
  const userId = c.var.userId;
  const now = Date.now();
  await db.batch([
    putSealedStmt(db, userId, "anthropic", await sealSecret(c.env, userId, "anthropic", apiKey), null, now),
    auditStmt(db, { userId, actor: "user", action: "secret_changed", summary: "Anthropic API key saved" }, now),
  ]);
  return c.json(ok);
});

accountRoutes.delete("/secrets/anthropic", async (c) => {
  const db = c.var.db;
  const userId = c.var.userId;
  await db.batch([
    deleteSecretsStmt(db, userId, ["anthropic"]),
    auditStmt(db, { userId, actor: "user", action: "secret_changed", summary: "Anthropic API key removed" }),
  ]);
  return c.json(ok);
});

/** D19: deletes the user row; ON DELETE CASCADE removes sessions, secrets, settings, cache, intents, audit.
 *  YNAB data itself is never touched. Needs only a session (requireAllowedUser exempts this route). */
accountRoutes.delete("/account", async (c) => {
  await c.var.db.delete(users).where(eq(users.id, c.var.userId));
  await destroySession(c); // the row is already gone via the cascade; this clears the cookie
  return c.json(ok);
});

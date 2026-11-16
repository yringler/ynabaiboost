// auth/settings.ts — WP2 (DESIGN §8.2). user_settings.json validated by the shared SettingsShape.
import { and, eq } from "drizzle-orm";
import { resolveSettings, SettingsShape, type Settings, type SettingsPatch } from "../../shared/schemas";
import { syncState, userSettings } from "../db/schema";
import type { BatchItem, DB } from "../env";

export async function getSettings(db: DB, userId: string): Promise<Settings> {
  const row = await db.select({ json: userSettings.json }).from(userSettings).where(eq(userSettings.userId, userId)).get();
  if (!row) return resolveSettings(null);
  let stored: unknown = null;
  try {
    stored = JSON.parse(row.json);
  } catch {
    stored = null; // corrupt JSON: fall back to defaults rather than locking the user out
  }
  return resolveSettings(stored);
}

/** Merges the patch over the current settings and validates the result.
 *  Changing planId to a different plan resets that plan's sync_state (initial sync on next sync) and,
 *  unless the patch sets it too, clears defaultAccountId (accounts belong to a plan). */
export async function updateSettings(db: DB, userId: string, patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings(db, userId);
  const merged: Settings = { ...current, ...patch };
  const planChanged = patch.planId !== undefined && patch.planId !== current.planId;
  if (planChanged && patch.defaultAccountId === undefined) merged.defaultAccountId = null;
  const next = SettingsShape.parse(merged);
  const now = Date.now();
  const json = JSON.stringify(next);
  const stmts: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db
      .insert(userSettings)
      .values({ userId, json, updatedAt: now })
      .onConflictDoUpdate({ target: userSettings.userId, set: { json, updatedAt: now } }),
  ];
  if (planChanged && next.planId !== null) {
    stmts.push(db.delete(syncState).where(and(eq(syncState.userId, userId), eq(syncState.planId, next.planId))));
  }
  await db.batch(stmts);
  return next;
}

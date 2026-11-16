// auth/settings.ts — WP2 (DESIGN §8.2). Stub created by WP1.
import type { Settings, SettingsPatch } from "../../shared/schemas";
import type { DB } from "../env";

export async function getSettings(_db: DB, _userId: string): Promise<Settings> {
  throw new Error("not implemented: getSettings");
}
export async function updateSettings(_db: DB, _userId: string, _patch: SettingsPatch): Promise<Settings> {
  throw new Error("not implemented: updateSettings");
}

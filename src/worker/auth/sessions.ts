// auth/sessions.ts — WP2 (DESIGN §8.2). Stub created by WP1.
import type { Context } from "hono";
import type { AppEnv } from "../env";

/** Sets the __Host-sid cookie. */
export async function createSession(_c: Context<AppEnv>, _userId: string): Promise<void> {
  throw new Error("not implemented: createSession");
}
export async function destroySession(_c: Context<AppEnv>): Promise<void> {
  throw new Error("not implemented: destroySession");
}

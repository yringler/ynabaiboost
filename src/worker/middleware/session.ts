// middleware/session.ts — WP2 (DESIGN §8.2). Stub created by WP1.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

/** Sets userId, user, sessionIdHash; rolling refresh. */
export const requireSession: MiddlewareHandler<AppEnv> = async () => {
  throw new Error("not implemented: requireSession");
};
/** isAllowed, else 403 not_allowed. */
export const requireAllowedUser: MiddlewareHandler<AppEnv> = async () => {
  throw new Error("not implemented: requireAllowedUser");
};
export const requireAdmin: MiddlewareHandler<AppEnv> = async () => {
  throw new Error("not implemented: requireAdmin");
};

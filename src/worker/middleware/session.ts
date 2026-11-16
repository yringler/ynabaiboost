// middleware/session.ts — WP2 (DESIGN §8.2, §4, D16).
import type { MiddlewareHandler } from "hono";
import { clearSessionCookie, readSessionToken, setSessionCookie, validateSessionToken } from "../auth/sessions";
import { isAdmin, isAllowed } from "../auth/users";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";

/** Sets userId, user, sessionIdHash; rolling refresh. 401 unauthenticated otherwise. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readSessionToken(c);
  if (!token) throw new AppError("unauthenticated", "Sign in first");
  const s = await validateSessionToken(c.var.db, token);
  if (!s) {
    clearSessionCookie(c);
    throw new AppError("unauthenticated", "Your session has expired. Sign in again.");
  }
  if (s.rolled) setSessionCookie(c, token);
  c.set("userId", s.user.id);
  c.set("user", s.user);
  c.set("sessionIdHash", s.idHash);
  await next();
};

/** isAllowed, else 403 not_allowed. `DELETE /api/account` needs only a session (DESIGN §7), so a
 *  removed user can still delete their data. */
export const requireAllowedUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const exempt = c.req.method === "DELETE" && c.req.path === "/api/account";
  if (!exempt && !isAllowed(c.env, c.var.userId)) {
    throw new AppError("not_allowed", `This YNAB account is not allowed to use the app. Your user id: ${c.var.userId}`);
  }
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdmin(c.env, c.var.userId)) throw new AppError("forbidden", "Admins only");
  await next();
};

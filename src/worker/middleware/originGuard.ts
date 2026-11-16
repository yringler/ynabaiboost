// src/worker/middleware/originGuard.ts — D20 CSRF guard (DESIGN §4)
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Non-GET/HEAD/OPTIONS: Sec-Fetch-Site must be same-origin; if absent, Origin must equal APP_ORIGIN; else 403. */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const site = c.req.header("Sec-Fetch-Site");
  if (site !== undefined) {
    if (site !== "same-origin") throw new AppError("forbidden", "Cross-site request refused");
    return next();
  }
  const origin = c.req.header("Origin");
  if (origin !== undefined && origin === c.env.APP_ORIGIN) return next();
  throw new AppError("forbidden", "Missing or foreign Origin");
};

// middleware/requireJson.ts — WP2 (D20 Content-Type rule, §4).
// validate("json", …) in lib/validate.ts now enforces this for every JSON route; this middleware remains for
// routes that read a JSON body without the validator and is harmless when stacked in front of validate().
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { isJsonContentType } from "../lib/validate";

export const requireJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isJsonContentType(c.req.header("Content-Type"))) throw new AppError("validation", "Content-Type must be application/json");
  await next();
};

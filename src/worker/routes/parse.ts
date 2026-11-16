// routes/parse.ts — WP4 (DESIGN §7, §9): POST /api/intents/parse. Needs consent and a key. Writes nothing.
// Mounted at /api before intentRoutes, so this path wins over /intents/:id.
import { Hono } from "hono";
import { API } from "../../shared/api";
import { getSettings } from "../auth/settings";
import { parseUtterance } from "../ai/parse";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validate";

export const parseRoutes = new Hono<AppEnv>();

parseRoutes.post("/intents/parse", validate("json", API.parse.req), async (c) => {
  const { db, userId } = c.var;
  const { text } = c.req.valid("json");
  const settings = await getSettings(db, userId);
  if (!settings.planId) throw new AppError("no_plan_selected", "Choose a YNAB plan first");
  const res = await parseUtterance({ env: c.env, db, userId, planId: settings.planId, settings }, text);
  return c.json(API.parse.res.parse(res));
});

// routes/edit.ts — DESIGN §7, §9.6: POST /api/intents/edit (preview, or apply at once with autoApplyEdits) and
// POST /api/intents/edit/apply (by server-issued token). Mounted before intentRoutes, like parseRoutes.
import { Hono } from "hono";
import { API } from "../../shared/api";
import type { AppEnv } from "../env";
import { validate } from "../lib/validate";
import { applyEdit, previewEdit } from "../services/edit";
import { loadBase } from "../services/intents";

export const editRoutes = new Hono<AppEnv>();

editRoutes.post("/intents/edit", validate("json", API.editIntents.req), async (c) => {
  const body = c.req.valid("json");
  const b = await loadBase(c.var.db, c.var.userId);
  return c.json(API.editIntents.res.parse(await previewEdit(c.env, b, body)));
});

editRoutes.post("/intents/edit/apply", validate("json", API.applyEdit.req), async (c) => {
  const { token } = c.req.valid("json");
  const b = await loadBase(c.var.db, c.var.userId);
  return c.json(API.applyEdit.res.parse(await applyEdit(c.env, b, token)));
});

// routes/stt.ts — WP4 (DESIGN §7, §11.3): POST /api/stt with a raw audio body → { text }.
// Active users with users.stt_allowed only (403 stt_not_allowed). bodyLimit 2 MB (413); Content-Type allowlist (415).
// CSRF: a raw-audio POST is covered by originGuard (Sec-Fetch-Site / Origin), §4.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { API } from "../../shared/api";
import { getSettings } from "../auth/settings";
import { STT_HINTS, transcribe } from "../ai/stt";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { getSelectableCategories, getTopPayees } from "../ynab/cache";

export const STT_MAX_BYTES = 2 * 1024 * 1024;
export const STT_TYPES: ReadonlySet<string> = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav"]);

/** "audio/webm;codecs=opus" → "audio/webm" (lower-cased). */
export const baseMediaType = (ct: string | undefined): string => (ct ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

export const sttRoutes = new Hono<AppEnv>();

sttRoutes.post(
  "/stt",
  async (c, next) => {
    if (!c.var.user.sttAllowed) throw new AppError("stt_not_allowed", "Server voice input is not enabled for your account");
    if (!STT_TYPES.has(baseMediaType(c.req.header("Content-Type")))) {
      throw new AppError("unsupported_media", "Unsupported audio format");
    }
    await next();
  },
  bodyLimit({
    maxSize: STT_MAX_BYTES,
    onError: () => {
      throw new AppError("payload_too_large", "Recording is too long (max 2 MB)");
    },
  }),
  async (c) => {
    const { db, userId } = c.var;
    const contentType = c.req.header("Content-Type") ?? "";
    const audio = await c.req.arrayBuffer();
    if (audio.byteLength === 0) throw new AppError("validation", "Empty recording");

    // Vocabulary hints from the cache (best effort: no plan → no hints).
    const settings = await getSettings(db, userId);
    let hints = { payees: [] as string[], categories: [] as string[] };
    if (settings.planId) {
      const [payees, categories] = await Promise.all([
        getTopPayees(db, userId, settings.planId, STT_HINTS),
        getSelectableCategories(db, userId, settings.planId),
      ]);
      hints = { payees: payees.map((p) => p.name), categories: categories.slice(0, STT_HINTS).map((x) => x.name) };
    }
    const text = await transcribe(c.env, audio, baseMediaType(contentType), hints);
    return c.json(API.stt.res.parse({ text }));
  },
);

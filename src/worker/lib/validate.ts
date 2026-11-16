// src/worker/lib/validate.ts — WP1 helper (additive, not in §8): zValidator whose failures become
// ApiErrorBody `validation` (400) via AppError instead of @hono/zod-validator's default zod-error JSON.
//
// For target "json" it also enforces `Content-Type: application/json` (D20, BUILD_NOTES §6): Hono 4.13's json
// validator treats a non-JSON body as `{}`, which an all-optional schema (SettingsPatch, UpdateIntentReq …) would
// accept as a no-op. The hook runs for every request (success or failure), so the check lives there and the
// middleware keeps its precise input types.
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { AppError } from "./errors";

const JSON_MEDIA = /^application\/([\w.-]+\+)?json$/i;

export const isJsonContentType = (header: string | undefined): boolean =>
  JSON_MEDIA.test((header ?? "").split(";")[0]?.trim() ?? "");

export const validate = <Target extends keyof ValidationTargets, T extends z.ZodType>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (target === "json" && !isJsonContentType(c.req.header("Content-Type"))) {
      throw new AppError("validation", "Content-Type must be application/json");
    }
    if (!result.success) {
      const message = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new AppError("validation", message);
    }
  });

// src/worker/lib/validate.ts — WP1 helper (additive, not in §8): zValidator whose failures become
// ApiErrorBody `validation` (400) via AppError instead of @hono/zod-validator's default zod-error JSON.
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { AppError } from "./errors";

export const validate = <Target extends keyof ValidationTargets, T extends z.ZodType>(target: Target, schema: T) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const message = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new AppError("validation", message);
    }
  });

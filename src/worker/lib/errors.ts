// src/worker/lib/errors.ts — DESIGN §8.1
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { ERROR_STATUS, type ErrorCode } from "../../shared/api";
import type { AppEnv } from "../env";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public override readonly cause?: unknown,
  ) {
    super(message ?? code);
    this.name = "AppError";
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

const HTTP_STATUS_CODE: Partial<Record<number, ErrorCode>> = {
  400: "validation",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media",
  429: "rate_limited",
};

function body(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

/** AppError → ApiErrorBody; ZodError → validation; HTTPException → mapped code; else internal (logged). */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError) {
    return c.json(body(err.code, err.message), err.status as ContentfulStatusCode);
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return c.json(body("validation", message), 400);
  }
  if (err instanceof HTTPException) {
    const code = HTTP_STATUS_CODE[err.status] ?? (err.status >= 500 ? "internal" : "validation");
    return c.json(body(code, err.message || code), ERROR_STATUS[code] as ContentfulStatusCode);
  }
  // Never log request bodies, tokens or keys (DESIGN §16): name + message + stack only.
  console.error(JSON.stringify({ msg: "unhandled_error", route: c.req.path, name: err.name, error: err.message, stack: err.stack }));
  return c.json(body("internal", "Internal error"), 500);
};

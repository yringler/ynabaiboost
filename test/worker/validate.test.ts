// lib/validate.ts: JSON routes reject a non-JSON Content-Type even when the schema is all-optional.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppEnv } from "../../src/worker/env";
import { errorHandler } from "../../src/worker/lib/errors";
import { isJsonContentType, validate } from "../../src/worker/lib/validate";

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.post("/x", validate("json", z.object({ a: z.number().optional() })), (c) => c.json(c.req.valid("json")));

const post = (body: string, type?: string) =>
  app.request("/x", { method: "POST", body, headers: type ? { "Content-Type": type } : {} });

describe("validate('json')", () => {
  it("accepts application/json (with charset) and +json", async () => {
    expect((await post('{"a":1}', "application/json; charset=utf-8")).status).toBe(200);
    expect(isJsonContentType("application/merge-patch+json")).toBe(true);
  });
  it("rejects text/plain and a missing Content-Type with 400 validation", async () => {
    for (const t of ["text/plain", undefined]) {
      const res = await post('{"a":1}', t);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation");
    }
  });
  it("still reports schema errors as validation", async () => {
    const res = await post('{"a":"x"}', "application/json");
    expect(res.status).toBe(400);
  });
});

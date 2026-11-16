// D20 CSRF guard, exercised both in isolation and through the composed app (DESIGN §4).
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/worker/env";
import { errorHandler } from "../../src/worker/lib/errors";
import { originGuard } from "../../src/worker/middleware/originGuard";

const ORIGIN = env.APP_ORIGIN; // "https://app.test" (vitest.config.ts)

function mini() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", originGuard);
  app.all("/x", (c) => c.json({ ok: true }));
  return app;
}
const send = (method: string, headers: Record<string, string>, body?: string) =>
  mini().request("/x", { method, headers, body }, env);

describe("originGuard", () => {
  it("passes GET/HEAD/OPTIONS without headers", async () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect((await send(m, {})).status).toBe(200);
  });
  it("passes same-origin Sec-Fetch-Site", async () => {
    expect((await send("POST", { "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  });
  it.each(["cross-site", "same-site", "none"])("rejects Sec-Fetch-Site: %s even with a matching Origin", async (site) => {
    const res = await send("POST", { "Sec-Fetch-Site": site, Origin: ORIGIN });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  });
  it("falls back to Origin when Sec-Fetch-Site is absent", async () => {
    expect((await send("DELETE", { Origin: ORIGIN })).status).toBe(200);
    expect((await send("DELETE", { Origin: "https://evil.example" })).status).toBe(403);
  });
  it("rejects a body-less POST with neither header", async () => {
    expect((await send("POST", {})).status).toBe(403);
  });
  it("rejects a JSON POST with neither header", async () => {
    expect((await send("POST", { "Content-Type": "application/json" }, "{}")).status).toBe(403);
  });
});

describe("composed app", () => {
  it("refuses a cross-site POST to /api/sync before any session check", async () => {
    const res = await exports.default.fetch(
      new Request("https://app.test/api/sync", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } }),
    );
    expect(res.status).toBe(403);
    // hono/csrf (also Sec-Fetch-Site aware) or originGuard rejects first; both yield ApiErrorBody forbidden.
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  });
  it("lets a same-origin POST through the guard (unknown /auth route → 404 ApiErrorBody)", async () => {
    const res = await exports.default.fetch(
      new Request("https://app.test/auth/does-not-exist", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
  it("sets secure headers", async () => {
    const res = await exports.default.fetch(new Request("https://app.test/auth/nothing"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

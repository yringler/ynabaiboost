// WP2: sessions (D6), requireSession rolling refresh, requireAllowedUser / account deletion.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { putSecret } from "../../src/worker/auth/secrets";
import { createSession, SESSION_ROLL_MS, SESSION_TTL_MS } from "../../src/worker/auth/sessions";
import { getDb } from "../../src/worker/db/client";
import { sessions, userSecrets, userSettings, users } from "../../src/worker/db/schema";
import type { AppEnv } from "../../src/worker/env";
import { errorHandler } from "../../src/worker/lib/errors";
import { sha256Hex } from "../../src/worker/lib/ids";
import { call, db, envWith, seedSession, seedUser, setCookies, uid } from "./wp2-helpers";

const sidCookie = (res: Response) => setCookies(res).find((s) => s.startsWith("__Host-sid="));

describe("createSession", () => {
  it("stores only the SHA-256 of the token and sets the cookie", async () => {
    const u = uid();
    await seedUser(u);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use("*", async (c, next) => {
      c.set("db", getDb(c.env));
      await next();
    });
    app.post("/login", async (c) => {
      await createSession(c, u);
      return c.text("ok");
    });
    const res = await app.request("/login", { method: "POST", headers: { "User-Agent": "TestUA/1.0" } }, env);
    const sc = sidCookie(res)!;
    const token = sc.slice("__Host-sid=".length).split(";")[0]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db().select().from(sessions).where(eq(sessions.userId, u));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idHash).toBe(await sha256Hex(token));
    expect(rows[0]!.idHash).not.toContain(token);
    expect(rows[0]!.userAgent).toBe("TestUA/1.0");
    expect(rows[0]!.expiresAt - rows[0]!.createdAt).toBe(SESSION_TTL_MS);
  });
});

describe("requireSession", () => {
  const e = envWith({ ALLOWED_USER_IDS: "*" });

  it("401 unauthenticated without a cookie or with an unknown token", async () => {
    const r1 = await call(e, "GET", "/api/settings");
    expect(r1.status).toBe(401);
    expect(await r1.json()).toMatchObject({ error: { code: "unauthenticated" } });
    const r2 = await call(e, "GET", "/api/settings", { cookie: "__Host-sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(r2.status).toBe(401);
    expect(sidCookie(r2)).toMatch(/Max-Age=0/);
    const r3 = await call(e, "GET", "/api/settings", { cookie: "sid=whatever" }); // un-prefixed name is ignored
    expect(r3.status).toBe(401);
  });

  it("accepts a valid session without re-setting the cookie when seen < 24 h ago", async () => {
    const u = uid();
    await seedUser(u);
    const s = await seedSession(u);
    const res = await call(e, "GET", "/api/settings", { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(sidCookie(res)).toBeUndefined();
  });

  it("rolls the expiry and re-sets the cookie when last seen > 24 h ago", async () => {
    const u = uid();
    const old = Date.now() - SESSION_ROLL_MS - 60_000;
    await seedUser(u, { lastSeenAt: old });
    const s = await seedSession(u, { lastSeenAt: old, expiresAt: old + SESSION_TTL_MS });
    const before = Date.now();
    const res = await call(e, "GET", "/api/settings", { cookie: s.cookie });
    expect(res.status).toBe(200);
    const sc = sidCookie(res)!;
    expect(sc).toContain(`__Host-sid=${s.token}`);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Max-Age=15552000/);
    const row = await db().select().from(sessions).where(eq(sessions.idHash, s.idHash)).get();
    expect(row!.lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(row!.expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    const user = await db().select().from(users).where(eq(users.id, u)).get();
    expect(user!.lastSeenAt).toBeGreaterThanOrEqual(before);
  });

  it("rejects an expired session and deletes its row", async () => {
    const u = uid();
    await seedUser(u);
    const s = await seedSession(u, { expiresAt: Date.now() - 1 });
    const res = await call(e, "GET", "/api/settings", { cookie: s.cookie });
    expect(res.status).toBe(401);
    expect(await db().select().from(sessions).where(eq(sessions.idHash, s.idHash))).toHaveLength(0);
  });
});

describe("requireAllowedUser", () => {
  it("403 not_allowed once the user id leaves the allow-list (with the id in the message)", async () => {
    const u = uid();
    await seedUser(u);
    const s = await seedSession(u);
    const ok = await call(envWith({ ALLOWED_USER_IDS: u }), "GET", "/api/settings", { cookie: s.cookie });
    expect(ok.status).toBe(200);
    const res = await call(envWith({ ALLOWED_USER_IDS: "", ADMIN_USER_IDS: "" }), "GET", "/api/settings", { cookie: s.cookie });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("not_allowed");
    expect(body.error.message).toContain(u);
  });

  it("admins are always allowed", async () => {
    const u = uid();
    await seedUser(u);
    const s = await seedSession(u);
    const res = await call(envWith({ ALLOWED_USER_IDS: "", ADMIN_USER_IDS: u }), "GET", "/api/settings", { cookie: s.cookie });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/account", () => {
  it("deletes the user and cascades; clears the cookie; works for a user no longer allowed", async () => {
    const u = uid();
    await seedUser(u);
    const s = await seedSession(u);
    await putSecret(env, db(), u, "anthropic", "sk-ant-x");
    await db().insert(userSettings).values({ userId: u, json: "{}", updatedAt: 1 });
    const res = await call(envWith({ ALLOWED_USER_IDS: "", ADMIN_USER_IDS: "" }), "DELETE", "/api/account", { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sidCookie(res)).toMatch(/Max-Age=0/);
    expect(await db().select().from(users).where(eq(users.id, u))).toHaveLength(0);
    expect(await db().select().from(sessions).where(eq(sessions.userId, u))).toHaveLength(0);
    expect(await db().select().from(userSecrets).where(eq(userSecrets.userId, u))).toHaveLength(0);
    expect(await db().select().from(userSettings).where(eq(userSettings.userId, u))).toHaveLength(0);
    // the old cookie no longer works
    const again = await call(envWith({ ALLOWED_USER_IDS: "*" }), "GET", "/api/settings", { cookie: s.cookie });
    expect(again.status).toBe(401);
  });

  it("requires a session and a same-origin request", async () => {
    expect((await call(env, "DELETE", "/api/account")).status).toBe(401);
    const u = uid();
    await seedUser(u);
    const s = await seedSession(u);
    const res = await call(envWith({ ALLOWED_USER_IDS: "*" }), "DELETE", "/api/account", {
      cookie: s.cookie, headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(await db().select().from(users).where(eq(users.id, u))).toHaveLength(1);
  });
});

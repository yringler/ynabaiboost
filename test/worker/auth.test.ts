// WP2: allow-list, PAT login, YNAB OAuth (PKCE) flow, token refresh lock (DESIGN §7, §12 WP2, §13 Auth).
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSecret, putSecret } from "../../src/worker/auth/secrets";
import { isAdmin, isAllowed, upsertUser } from "../../src/worker/auth/users";
import { acquireLock, getYnabAccessToken, markNeedsReauth } from "../../src/worker/auth/ynabToken";
import { auditLog, sessions, userSecrets, users } from "../../src/worker/db/schema";
import type { YnabApiError as YnabApiErrorT } from "../../src/worker/ynab/errors";
import { call, cookieFrom, db, envWith, loadFreshApp, seedSession, seedUser, setCookies, uid } from "./wp2-helpers";

// WP3's client may still be a stub: fake the one function WP2 uses (GET /user).
// A plain function, not vi.fn: a vi.fn returning a rejected promise is reported as an unhandled rejection in workerd.
const ynab = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    impl: (_token: string): Promise<string> => Promise.reject(new Error("getUserId not set up")),
    getUserId: (token: string) => {
      state.calls.push(token);
      return state.impl(token);
    },
    resolve(id: string) { state.impl = async () => id; },
    reject(e: unknown) { state.impl = async () => { throw e; }; },
    reset() { state.calls = []; state.impl = () => Promise.reject(new Error("getUserId not set up")); },
  };
  return state;
});
vi.mock("../../src/worker/ynab/client", async (orig) => ({
  ...(await orig<typeof import("../../src/worker/ynab/client")>()),
  createYnabClientForToken: (token: string) => ({ getUserId: () => ynab.getUserId(token) }),
}));
vi.mock("../../src/worker/engine/reconcile", async (orig) => ({
  ...(await orig<typeof import("../../src/worker/engine/reconcile")>()),
  countOpen: async () => ({ pending: 2, stale: 1, review: 0 }),
}));

const network = setupNetwork();
let YnabApiError: typeof YnabApiErrorT;
beforeAll(async () => {
  network.enable();
  await loadFreshApp();
  ({ YnabApiError } = await import("../../src/worker/ynab/errors"));
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
beforeEach(() => ynab.reset());

const PAT = "pat-0123456789abcdefghijklmnop";
const ip = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe("isAdmin / isAllowed (D16)", () => {
  const e = envWith({ ADMIN_USER_IDS: " a1 , a2", ALLOWED_USER_IDS: "u1,u2" });
  it("parses comma lists with whitespace", () => {
    expect(isAdmin(e, "a1")).toBe(true);
    expect(isAdmin(e, "a2")).toBe(true);
    expect(isAdmin(e, "u1")).toBe(false);
    expect(isAdmin(e, "")).toBe(false);
  });
  it("allows admins, listed users and '*'", () => {
    expect(isAllowed(e, "a1")).toBe(true);
    expect(isAllowed(e, "u2")).toBe(true);
    expect(isAllowed(e, "x")).toBe(false);
    expect(isAllowed(envWith({ ADMIN_USER_IDS: "", ALLOWED_USER_IDS: "*" }), "anyone")).toBe(true);
    expect(isAllowed(envWith({ ADMIN_USER_IDS: "", ALLOWED_USER_IDS: "" }), "anyone")).toBe(false);
    expect(isAllowed(envWith({ ADMIN_USER_IDS: "", ALLOWED_USER_IDS: "*" }), "")).toBe(false);
  });
});

describe("upsertUser", () => {
  it("re-login with another auth type replaces the secrets and clears needs_reauth", async () => {
    const u = uid();
    await upsertUser(env, db(), u, "oauth");
    await putSecret(env, db(), u, "ynab_access", "acc");
    await putSecret(env, db(), u, "ynab_refresh", "ref");
    await putSecret(env, db(), u, "anthropic", "sk-ant-x");
    await markNeedsReauth(db(), u);
    const row = await upsertUser(env, db(), u, "pat");
    expect(row).toMatchObject({ id: u, authType: "pat", needsReauth: false });
    expect(await getSecret(env, db(), u, "ynab_access")).toBeNull();
    expect(await getSecret(env, db(), u, "ynab_refresh")).toBeNull();
    expect(await getSecret(env, db(), u, "anthropic")).not.toBeNull(); // unrelated secret kept
  });
});

describe("GET /auth/config", () => {
  it("oauthAvailable requires a client id and a real secret", async () => {
    const r1 = await call(envWith({ YNAB_CLIENT_ID: "", YNAB_CLIENT_SECRET: "s" }), "GET", "/auth/config");
    expect(await r1.json()).toEqual({ oauthAvailable: false });
    const r2 = await call(envWith({ YNAB_CLIENT_ID: "cid", YNAB_CLIENT_SECRET: "disabled" }), "GET", "/auth/config");
    expect(await r2.json()).toEqual({ oauthAvailable: false });
    const r3 = await call(envWith({ YNAB_CLIENT_ID: "cid", YNAB_CLIENT_SECRET: "s" }), "GET", "/auth/config");
    expect(await r3.json()).toEqual({ oauthAvailable: true });
  });
});

describe("POST /auth/pat", () => {
  it("creates the user, stores the PAT sealed, sets a __Host-sid cookie and returns Me", async () => {
    const u = uid();
    ynab.resolve(u);
    const e = envWith({ ALLOWED_USER_IDS: u, ADMIN_USER_IDS: "" });
    const res = await call(e, "POST", "/auth/pat", { body: { token: PAT }, headers: { "CF-Connecting-IP": ip() } });
    expect(res.status).toBe(200);
    expect(ynab.calls).toEqual([PAT]);
    const me = await res.json<Record<string, unknown>>();
    expect(me).toMatchObject({ userId: u, authType: "pat", isAdmin: false, needsReauth: false, hasAnthropicKey: false, plan: null });

    const sc = setCookies(res).find((s) => s.startsWith("__Host-sid="));
    expect(sc).toBeDefined();
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/i);
    expect(sc).toMatch(/Max-Age=15552000/);

    expect(await getSecret(env, db(), u, "ynab_pat")).toEqual({ value: PAT, expiresAt: null });
    const sess = await db().select().from(sessions).where(eq(sessions.userId, u));
    expect(sess).toHaveLength(1);
    const audit = await db().select().from(auditLog).where(and(eq(auditLog.userId, u), eq(auditLog.action, "login")));
    expect(audit).toHaveLength(1);

    // the cookie works for /api/me
    const meRes = await call(e, "GET", "/api/me", { cookie: cookieFrom(res, "__Host-sid") });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({ userId: u });
  });

  it("refuses a user that is not allowed with their id, storing nothing", async () => {
    const u = uid();
    ynab.resolve(u);
    const res = await call(envWith({ ALLOWED_USER_IDS: "someone-else", ADMIN_USER_IDS: "" }), "POST", "/auth/pat", {
      body: { token: PAT }, headers: { "CF-Connecting-IP": ip() },
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("not_allowed");
    expect(body.error.message).toContain(u);
    expect(setCookies(res).some((s) => s.startsWith("__Host-sid="))).toBe(false);
    expect(await db().select().from(users).where(eq(users.id, u))).toHaveLength(0);
    expect(await db().select().from(userSecrets).where(eq(userSecrets.userId, u))).toHaveLength(0);
  });

  it("maps a YNAB 401 to a validation error", async () => {
    ynab.reject(new YnabApiError(401, { id: "401", name: "unauthorized", detail: "bad" }));
    const res = await call(envWith({ ALLOWED_USER_IDS: "*" }), "POST", "/auth/pat", { body: { token: PAT }, headers: { "CF-Connecting-IP": ip() } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation" } });
  });

  it("maps other YNAB errors via toAppError (wrapped in the SDK's FetchError too)", async () => {
    const inner = new YnabApiError(403, { id: "403.1", name: "subscription_lapsed", detail: "x" });
    ynab.reject(new Error("FetchError", { cause: inner }));
    const res = await call(envWith({ ALLOWED_USER_IDS: "*" }), "POST", "/auth/pat", { body: { token: PAT }, headers: { "CF-Connecting-IP": ip() } });
    expect(await res.json()).toMatchObject({ error: { code: "ynab_subscription_lapsed" } });
  });

  it("rate-limits before validating the body or calling YNAB (D21)", async () => {
    const limit = vi.fn(async (_o: RateLimitOptions) => ({ success: false }));
    const res = await call(envWith({ ALLOWED_USER_IDS: "*", PAT_LIMITER: { limit } }), "POST", "/auth/pat", {
      body: { token: "short" }, headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(limit).toHaveBeenCalledWith({ key: "1.2.3.4" });
    expect(ynab.calls).toEqual([]);
  });

  it("validates the body with ApiErrorBody", async () => {
    const res = await call(envWith({ ALLOWED_USER_IDS: "*" }), "POST", "/auth/pat", { body: { token: "short" }, headers: { "CF-Connecting-IP": ip() } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation" } });
  });

  it("is refused cross-site (CSRF)", async () => {
    const res = await call(envWith({ ALLOWED_USER_IDS: "*" }), "POST", "/auth/pat", {
      body: { token: PAT }, headers: { "Sec-Fetch-Site": "cross-site", "CF-Connecting-IP": ip() },
    });
    expect(res.status).toBe(403);
    expect(ynab.calls).toEqual([]);
  });
});

describe("POST /auth/logout", () => {
  it("deletes the session row, clears the cookie, audits logout", async () => {
    const u = uid();
    await seedUser(u);
    const s = await seedSession(u);
    const res = await call(env, "POST", "/auth/logout", { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setCookies(res).find((c) => c.startsWith("__Host-sid="))).toMatch(/Max-Age=0/);
    expect(await db().select().from(sessions).where(eq(sessions.idHash, s.idHash))).toHaveLength(0);
    const audit = await db().select().from(auditLog).where(and(eq(auditLog.userId, u), eq(auditLog.action, "logout")));
    expect(audit).toHaveLength(1);
  });
  it("is ok without a session", async () => {
    const res = await call(env, "POST", "/auth/logout");
    expect(res.status).toBe(200);
  });
});

// ── OAuth ──────────────────────────────────────────────────────────────────
const OAUTH_ENV = { YNAB_CLIENT_ID: "client-123", YNAB_CLIENT_SECRET: "client-secret" };
const TOKEN_URL = "https://app.ynab.com/oauth/token";

async function startOAuth(e: Env) {
  const res = await call(e, "GET", "/auth/ynab/start");
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("Location")!);
  const cookie = cookieFrom(res, "__Host-oauth");
  expect(cookie).toBeDefined();
  return { res, loc, cookie: cookie!, state: loc.searchParams.get("state")! };
}

describe("OAuth", () => {
  it("/auth/ynab/start is 404 when OAuth is not configured", async () => {
    const res = await call(envWith({ YNAB_CLIENT_ID: "" }), "GET", "/auth/ynab/start");
    expect(res.status).toBe(404);
  });

  it("/auth/ynab/start redirects with PKCE S256 and sets a signed 10-minute __Host-oauth cookie", async () => {
    const { loc, res } = await startOAuth(envWith(OAUTH_ENV));
    expect(loc.origin + loc.pathname).toBe("https://app.ynab.com/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("client-123");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://app.test/auth/ynab/callback");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.has("scope")).toBe(false);
    const sc = setCookies(res).find((s) => s.startsWith("__Host-oauth="))!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Max-Age=600/);
  });

  it("callback: exchanges the code with the PKCE verifier, stores tokens, creates a session", async () => {
    const u = uid();
    const e = envWith({ ...OAUTH_ENV, ALLOWED_USER_IDS: u });
    const { state, cookie, loc } = await startOAuth(e);
    let form: URLSearchParams | undefined;
    network.use(
      http.post(TOKEN_URL, async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({ access_token: "acc-1", token_type: "Bearer", expires_in: 7200, refresh_token: "ref-1", created_at: 1 });
      }),
    );
    ynab.resolve(u);
    const before = Date.now();
    const res = await call(e, "GET", `/auth/ynab/callback?code=the-code&state=${state}`, { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(setCookies(res).find((s) => s.startsWith("__Host-oauth="))).toMatch(/Max-Age=0/);
    expect(cookieFrom(res, "__Host-sid")).toBeDefined();

    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code")).toBe("the-code");
    expect(form?.get("client_id")).toBe("client-123");
    expect(form?.get("client_secret")).toBe("client-secret");
    expect(form?.get("redirect_uri")).toBe("https://app.test/auth/ynab/callback");
    // verifier matches the challenge sent to /authorize
    const verifier = form?.get("code_verifier") ?? "";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(loc.searchParams.get("code_challenge"));

    expect(ynab.calls).toEqual(["acc-1"]);
    const user = await db().select().from(users).where(eq(users.id, u)).get();
    expect(user?.authType).toBe("oauth");
    const acc = await getSecret(env, db(), u, "ynab_access");
    expect(acc?.value).toBe("acc-1");
    expect(acc?.expiresAt).toBeGreaterThanOrEqual(before + 7200_000);
    expect((await getSecret(env, db(), u, "ynab_refresh"))?.value).toBe("ref-1");
  });

  it("callback: a state mismatch is refused (and the cookie cleared)", async () => {
    const e = envWith({ ...OAUTH_ENV, ALLOWED_USER_IDS: "*" });
    const { cookie } = await startOAuth(e);
    const token = vi.fn(() => HttpResponse.json({}));
    network.use(http.post(TOKEN_URL, token));
    const res = await call(e, "GET", `/auth/ynab/callback?code=c&state=wrong-state`, { cookie });
    expect(res.headers.get("Location")).toBe("/login?error=oauth_state");
    expect(setCookies(res).find((s) => s.startsWith("__Host-oauth="))).toMatch(/Max-Age=0/);
    expect(token).not.toHaveBeenCalled();
  });

  it("callback: missing or forged cookie is refused", async () => {
    const e = envWith({ ...OAUTH_ENV, ALLOWED_USER_IDS: "*" });
    const { state, cookie } = await startOAuth(e);
    const r1 = await call(e, "GET", `/auth/ynab/callback?code=c&state=${state}`);
    expect(r1.headers.get("Location")).toBe("/login?error=oauth_state");
    const forged = cookie.replace(/=([^.]+)\./, "=x$1.");
    const r2 = await call(e, "GET", `/auth/ynab/callback?code=c&state=${state}`, { cookie: forged });
    expect(r2.headers.get("Location")).toBe("/login?error=oauth_state");
  });

  it("callback: a user who declined is sent back to /login", async () => {
    const e = envWith({ ...OAUTH_ENV, ALLOWED_USER_IDS: "*" });
    const { state, cookie } = await startOAuth(e);
    const res = await call(e, "GET", `/auth/ynab/callback?error=access_denied&state=${state}`, { cookie });
    expect(res.headers.get("Location")).toBe("/login?error=oauth_denied");
  });

  it("callback: a failed code exchange → /login?error=oauth_failed", async () => {
    const e = envWith({ ...OAUTH_ENV, ALLOWED_USER_IDS: "*" });
    const { state, cookie } = await startOAuth(e);
    network.use(http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })));
    const res = await call(e, "GET", `/auth/ynab/callback?code=c&state=${state}`, { cookie });
    expect(res.headers.get("Location")).toBe("/login?error=oauth_failed");
  });

  it("callback: a user who is not allowed → /login?error=not_allowed&uid=…, nothing stored", async () => {
    const u = uid();
    const e = envWith({ ...OAUTH_ENV, ALLOWED_USER_IDS: "nobody", ADMIN_USER_IDS: "" });
    const { state, cookie } = await startOAuth(e);
    network.use(http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "a", token_type: "bearer", expires_in: 7200, refresh_token: "r" })));
    ynab.resolve(u);
    const res = await call(e, "GET", `/auth/ynab/callback?code=c&state=${state}`, { cookie });
    expect(res.headers.get("Location")).toBe(`/login?error=not_allowed&uid=${u}`);
    expect(cookieFrom(res, "__Host-sid")).toBeUndefined();
    expect(await db().select().from(users).where(eq(users.id, u))).toHaveLength(0);
  });
});

// ── token refresh ──────────────────────────────────────────────────────────
const e = envWith(OAUTH_ENV);

async function seedOAuthUser(expiresAt: number) {
  const u = uid();
  await seedUser(u, { authType: "oauth" });
  await putSecret(e, db(), u, "ynab_access", "old-access", expiresAt);
  await putSecret(e, db(), u, "ynab_refresh", "old-refresh");
  return u;
}

describe("getYnabAccessToken", () => {
  it("returns a PAT as is", async () => {
    const u = uid();
    await seedUser(u, { authType: "pat" });
    await putSecret(e, db(), u, "ynab_pat", "my-pat");
    expect(await getYnabAccessToken(e, db(), u)).toBe("my-pat");
  });

  it("missing PAT → needs_reauth + ynab_reauth_required", async () => {
    const u = uid();
    await seedUser(u, { authType: "pat" });
    await expect(getYnabAccessToken(e, db(), u)).rejects.toMatchObject({ code: "ynab_reauth_required" });
    expect((await db().select().from(users).where(eq(users.id, u)).get())?.needsReauth).toBe(true);
  });

  it("returns a fresh OAuth access token without refreshing", async () => {
    const u = await seedOAuthUser(Date.now() + 60 * 60_000);
    const token = vi.fn(() => HttpResponse.json({}));
    network.use(http.post(TOKEN_URL, token));
    expect(await getYnabAccessToken(e, db(), u)).toBe("old-access");
    expect(token).not.toHaveBeenCalled();
  });

  it("refreshes when < 5 min left and stores both new tokens", async () => {
    const u = await seedOAuthUser(Date.now() + 60_000);
    let form: URLSearchParams | undefined;
    network.use(
      http.post(TOKEN_URL, async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({ access_token: "new-access", token_type: "bearer", expires_in: 7200, refresh_token: "new-refresh" });
      }),
    );
    expect(await getYnabAccessToken(e, db(), u)).toBe("new-access");
    expect(form?.get("grant_type")).toBe("refresh_token");
    expect(form?.get("refresh_token")).toBe("old-refresh");
    expect(form?.get("client_secret")).toBe("client-secret");
    expect((await getSecret(e, db(), u, "ynab_access"))?.value).toBe("new-access");
    expect((await getSecret(e, db(), u, "ynab_refresh"))?.value).toBe("new-refresh");
    expect((await db().select().from(users).where(eq(users.id, u)).get())?.tokenRefreshLockUntil).toBeNull();
  });

  it("two concurrent calls → exactly one token POST, both get the new token", async () => {
    const u = await seedOAuthUser(Date.now() - 1000);
    let posts = 0;
    network.use(
      http.post(TOKEN_URL, async () => {
        posts++;
        await delay(200);
        return HttpResponse.json({ access_token: `new-${posts}`, token_type: "bearer", expires_in: 7200, refresh_token: "r2" });
      }),
    );
    const [a, b] = await Promise.all([getYnabAccessToken(e, db(), u), getYnabAccessToken(e, db(), u)]);
    expect(posts).toBe(1);
    expect(a).toBe("new-1");
    expect(b).toBe("new-1");
  });

  it("invalid_grant → needs_reauth=1 and ynab_reauth_required; lock released", async () => {
    const u = await seedOAuthUser(Date.now() - 1000);
    network.use(http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })));
    await expect(getYnabAccessToken(e, db(), u)).rejects.toMatchObject({ code: "ynab_reauth_required" });
    const row = await db().select().from(users).where(eq(users.id, u)).get();
    expect(row?.needsReauth).toBe(true);
    expect(row?.tokenRefreshLockUntil).toBeNull();
    // later calls fail fast without a token POST
    const token = vi.fn(() => HttpResponse.json({}));
    network.use(http.post(TOKEN_URL, token));
    await expect(getYnabAccessToken(e, db(), u)).rejects.toMatchObject({ code: "ynab_reauth_required" });
    expect(token).not.toHaveBeenCalled();
  });

  it("a 5xx from the token endpoint → ynab_error, needs_reauth untouched", async () => {
    const u = await seedOAuthUser(Date.now() - 1000);
    network.use(http.post(TOKEN_URL, () => new HttpResponse("oops", { status: 503 })));
    await expect(getYnabAccessToken(e, db(), u)).rejects.toMatchObject({ code: "ynab_error" });
    const row = await db().select().from(users).where(eq(users.id, u)).get();
    expect(row?.needsReauth).toBe(false);
    expect(row?.tokenRefreshLockUntil).toBeNull();
  });

  it("acquireLock is exclusive until the lock expires", async () => {
    const u = uid();
    await seedUser(u, { authType: "oauth" });
    const now = Date.now();
    expect(await acquireLock(db(), u, now)).toBe(true);
    expect(await acquireLock(db(), u, now + 1000)).toBe(false);
    expect(await acquireLock(db(), u, now + 31_000)).toBe(true);
  });
});

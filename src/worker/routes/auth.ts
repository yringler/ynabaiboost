// routes/auth.ts — WP2 (DESIGN §7, §12 WP2): /auth/*. Public routes (no session required).
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { AuthConfigRes, PatLoginReq } from "../../shared/api";
import { Me } from "../../shared/schemas";
import { buildMe } from "../auth/me";
import { AuthorizationResponseError, exchangeCode, oauthAvailable, startAuthorization } from "../auth/oauth";
import { putSealedStmt, sealSecret } from "../auth/secrets";
import { createSession, destroySession } from "../auth/sessions";
import { isAllowed, upsertUser } from "../auth/users";
import type { AppEnv, BatchItem } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validate";
import { requireJson } from "../middleware/requireJson";
import { createYnabClientForToken } from "../ynab/client";
import { toAppError, YnabApiError } from "../ynab/errors";

const OAUTH_COOKIE = "oauth"; // sent as __Host-oauth
const OAUTH_COOKIE_MAX_AGE = 10 * 60;

/** The YnabApiError behind whatever the YNAB client threw (it may be wrapped in the SDK's FetchError). */
function ynabErrorOf(e: unknown): YnabApiError | null {
  if (e instanceof YnabApiError) return e;
  if (e instanceof Error && e.cause instanceof YnabApiError) return e.cause;
  return null;
}

/** Equal-length byte encodings compared with crypto.subtle.timingSafeEqual (DESIGN §7). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

const loginRedirect = (c: Context<AppEnv>, error: string, uid?: string) => {
  const q = new URLSearchParams({ error });
  if (uid !== undefined) q.set("uid", uid);
  return c.redirect(`/login?${q.toString()}`, 302);
};

const logEvent = (msg: string, extra: Record<string, unknown> = {}) => console.warn(JSON.stringify({ msg, ...extra }));

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/config", (c) => c.json(AuthConfigRes.parse({ oauthAvailable: oauthAvailable(c.env) })));

authRoutes.get("/ynab/start", async (c) => {
  if (!oauthAvailable(c.env)) throw new AppError("not_found", "YNAB sign-in is not configured");
  const { state, codeVerifier, url } = await startAuthorization(c.env);
  // Both values are base64url (no '.'), so "state.verifier" is unambiguous.
  await setSignedCookie(c, OAUTH_COOKIE, `${state}.${codeVerifier}`, c.env.SESSION_SECRET, {
    prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  c.header("Cache-Control", "no-store");
  return c.redirect(url, 302);
});

authRoutes.get("/ynab/callback", async (c) => {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, OAUTH_COOKIE, "host");
  // Always clear the one-shot cookie, whatever happens next.
  deleteCookie(c, OAUTH_COOKIE, { prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  c.header("Cache-Control", "no-store");
  if (!oauthAvailable(c.env)) return loginRedirect(c, "oauth_unavailable");

  const [cookieState, codeVerifier] = typeof raw === "string" ? raw.split(".") : [];
  const queryState = c.req.query("state") ?? "";
  if (!cookieState || !codeVerifier || !constantTimeEqual(queryState, cookieState)) {
    logEvent("oauth_state_mismatch");
    return loginRedirect(c, "oauth_state");
  }

  let accessToken: string;
  let refreshToken: string | null;
  let expiresAt: number | null;
  try {
    ({ accessToken, refreshToken, expiresAt } = await exchangeCode(c.env, new URL(c.req.url), codeVerifier));
  } catch (e) {
    if (e instanceof AuthorizationResponseError) {
      logEvent("oauth_denied", { error: e.error });
      return loginRedirect(c, "oauth_denied");
    }
    logEvent("oauth_exchange_failed", { name: e instanceof Error ? e.name : "unknown", error: e instanceof Error ? e.message : String(e) });
    return loginRedirect(c, "oauth_failed");
  }

  let userId: string;
  try {
    userId = await createYnabClientForToken(accessToken).getUserId();
  } catch (e) {
    logEvent("oauth_get_user_failed", { error: e instanceof Error ? e.message : String(e) });
    return loginRedirect(c, "oauth_failed");
  }
  if (!isAllowed(c.env, userId)) {
    logEvent("login_not_allowed", { userId, via: "oauth" });
    return loginRedirect(c, "not_allowed", userId); // nothing stored
  }

  const db = c.var.db;
  await upsertUser(c.env, db, userId, "oauth");
  const now = Date.now();
  const stmts: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    putSealedStmt(db, userId, "ynab_access", await sealSecret(c.env, userId, "ynab_access", accessToken), expiresAt, now),
    auditStmt(db, { userId, actor: "user", action: "login", summary: "Signed in with YNAB" }, now),
  ];
  if (refreshToken !== null) stmts.push(putSealedStmt(db, userId, "ynab_refresh", await sealSecret(c.env, userId, "ynab_refresh", refreshToken), null, now));
  await db.batch(stmts);
  await createSession(c, userId);
  return c.redirect("/", 302);
});

authRoutes.post(
  "/pat",
  // D21: rate limit by client IP before anything else (including body validation).
  async (c, next) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.PAT_LIMITER.limit({ key: ip });
    if (!success) throw new AppError("rate_limited", "Too many sign-in attempts. Wait a minute and try again.");
    await next();
  },
  requireJson, validate("json", PatLoginReq),
  async (c) => {
    const { token } = c.req.valid("json");
    let userId: string;
    try {
      userId = await createYnabClientForToken(token).getUserId();
    } catch (e) {
      const ye = ynabErrorOf(e);
      if (ye && ye.status === 401) throw new AppError("validation", "YNAB did not accept this token. Check it and try again.");
      if (ye) throw toAppError(ye);
      throw e;
    }
    if (!isAllowed(c.env, userId)) {
      logEvent("login_not_allowed", { userId, via: "pat" });
      throw new AppError("not_allowed", `This YNAB account is not allowed to use the app. Your user id: ${userId} (send it to the owner)`);
    }
    const db = c.var.db;
    const user = await upsertUser(c.env, db, userId, "pat");
    const now = Date.now();
    await db.batch([
      putSealedStmt(db, userId, "ynab_pat", await sealSecret(c.env, userId, "ynab_pat", token), null, now),
      auditStmt(db, { userId, actor: "user", action: "login", summary: "Signed in with a personal access token" }, now),
    ]);
    await createSession(c, userId);
    return c.json(Me.parse(await buildMe(c.env, db, user)));
  },
);

authRoutes.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true as const });
});

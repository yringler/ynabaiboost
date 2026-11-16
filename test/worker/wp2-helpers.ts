// WP2 test helpers (not a test file): seeded users/sessions and requests through the composed app.
import { env } from "cloudflare:workers";
import type { Hono } from "hono";
import { vi } from "vitest";
import { getDb } from "../../src/worker/db/client";
import { sessions, users } from "../../src/worker/db/schema";
import type { AppEnv } from "../../src/worker/env";
import { randomToken, sha256Hex } from "../../src/worker/lib/ids";

export const ORIGIN = "https://app.test";
export const db = () => getDb(env);

/** Fresh unique id per call, so tests within a file never collide on D1 state. */
let seq = 0;
export const uid = (p = "u") => `${p}-${Date.now().toString(36)}-${++seq}`;

export function envWith(over: Partial<Env>): Env {
  return { ...env, ...over } as Env;
}

export async function seedUser(id: string, opts: { authType?: "oauth" | "pat"; lastSeenAt?: number; sttAllowed?: boolean } = {}) {
  const now = Date.now();
  await db().insert(users).values({
    id, authType: opts.authType ?? "pat", sttAllowed: opts.sttAllowed ?? false, needsReauth: false,
    tokenRefreshLockUntil: null, createdAt: now, lastSeenAt: opts.lastSeenAt ?? now,
  });
}

/** Inserts a session row and returns the Cookie header value for it. */
export async function seedSession(userId: string, opts: { lastSeenAt?: number; expiresAt?: number } = {}) {
  const token = randomToken(32);
  const idHash = await sha256Hex(token);
  const now = Date.now();
  await db().insert(sessions).values({
    idHash, userId, createdAt: now, lastSeenAt: opts.lastSeenAt ?? now,
    expiresAt: opts.expiresAt ?? now + 180 * 86_400_000, userAgent: null,
  });
  return { token, idHash, cookie: `__Host-sid=${token}` };
}

let appRef: Hono<AppEnv> | null = null;

/** The worker's main module is loaded by the pool before a test file's vi.mock calls run, so modules that
 *  import a mocked module must be re-evaluated: reset the registry and import the composed app afresh.
 *  Classes used with instanceof (e.g. YnabApiError) must then be imported dynamically after this call too. */
export async function loadFreshApp(): Promise<Hono<AppEnv>> {
  vi.resetModules();
  appRef = (await import("../../src/worker/index")).app;
  return appRef;
}

async function getApp(): Promise<Hono<AppEnv>> {
  appRef ??= (await import("../../src/worker/index")).app;
  return appRef;
}

/** Request through the composed Hono app with a chosen Env. Non-GET requests are same-origin by default. */
export async function call(e: Env, method: string, path: string, init: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (method !== "GET" && !("Sec-Fetch-Site" in headers)) headers["Sec-Fetch-Site"] = "same-origin";
  if (init.cookie) headers.Cookie = init.cookie;
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] ??= "application/json";
  }
  return (await getApp()).request(`${ORIGIN}${path}`, { method, headers, body }, e);
}

/** All Set-Cookie headers of a response. */
export const setCookies = (res: Response): string[] => res.headers.getSetCookie();

/** "name=value" pairs from Set-Cookie, ready for a Cookie header. */
export function cookieFrom(res: Response, name: string): string | undefined {
  const sc = setCookies(res).find((s) => s.startsWith(`${name}=`));
  return sc?.split(";")[0];
}

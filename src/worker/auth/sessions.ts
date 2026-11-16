// auth/sessions.ts — WP2 (DESIGN §8.2, D6). Opaque 256-bit token in __Host-sid; D1 stores only its SHA-256.
// 180-day expiry, rolled forward at most once per 24 h (requireSession).
import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sessions, users } from "../db/schema";
import type { AppEnv, DB, UserRow } from "../env";
import { auditStmt } from "../lib/audit";
import { randomToken, sha256Hex } from "../lib/ids";

export const SESSION_COOKIE = "sid"; // sent as __Host-sid
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const SESSION_ROLL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT_MAX = 256;

/** Sets the __Host-sid cookie (HttpOnly, Secure, SameSite=Lax, Path=/). */
export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
}

export function readSessionToken(c: Context<AppEnv>): string | undefined {
  const t = getCookie(c, SESSION_COOKIE, "host");
  return t && /^[A-Za-z0-9_-]{20,128}$/.test(t) ? t : undefined;
}

/** Sets the __Host-sid cookie. */
export async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const db = c.var.db;
  const token = randomToken(32);
  const idHash = await sha256Hex(token);
  const now = Date.now();
  const ua = c.req.header("User-Agent");
  await db.insert(sessions).values({
    idHash, userId, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS,
    userAgent: ua ? ua.slice(0, USER_AGENT_MAX) : null,
  });
  setSessionCookie(c, token);
}

/** Deletes the session row (if any, auditing a logout) and always clears the cookie. */
export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = readSessionToken(c);
  clearSessionCookie(c);
  if (!token) return;
  const db = c.var.db;
  const idHash = await sha256Hex(token);
  const deleted = await db.delete(sessions).where(eq(sessions.idHash, idHash)).returning({ userId: sessions.userId });
  const userId = deleted[0]?.userId;
  if (userId) await auditStmt(db, { userId, actor: "user", action: "logout", summary: "Signed out" });
}

export interface ValidSession { idHash: string; user: UserRow; rolled: boolean }

/** WP2-internal: looks up a live session by cookie token, rolling its expiry when last_seen_at is > 24 h old.
 *  Expired rows are deleted. Returns null when there is no live session. */
export async function validateSessionToken(db: DB, token: string, now: number = Date.now()): Promise<ValidSession | null> {
  const idHash = await sha256Hex(token);
  const row = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash))
    .get();
  if (!row) return null;
  if (row.session.expiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.idHash, idHash));
    return null;
  }
  if (now - row.session.lastSeenAt < SESSION_ROLL_MS) return { idHash, user: row.user, rolled: false };
  await db.batch([
    db.update(sessions)
      .set({ lastSeenAt: now, expiresAt: now + SESSION_TTL_MS })
      .where(and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now))),
    db.update(users).set({ lastSeenAt: now }).where(eq(users.id, row.user.id)),
  ]);
  return { idHash, user: { ...row.user, lastSeenAt: now }, rolled: true };
}

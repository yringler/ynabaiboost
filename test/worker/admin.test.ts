// WP2: /api/admin/* guard and the STT toggle (DESIGN §7).
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, users } from "../../src/worker/db/schema";
import { call, db, envWith, seedSession, seedUser, uid } from "./wp2-helpers";

async function setup() {
  const admin = uid("admin");
  const member = uid("member");
  await seedUser(admin);
  await seedUser(member, { authType: "oauth" });
  const e = envWith({ ADMIN_USER_IDS: admin, ALLOWED_USER_IDS: member });
  return { admin, member, e, adminCookie: (await seedSession(admin)).cookie, memberCookie: (await seedSession(member)).cookie };
}

describe("admin guard", () => {
  it("401 without a session, 403 forbidden for a non-admin", async () => {
    const { e, memberCookie } = await setup();
    expect((await call(e, "GET", "/api/admin/users")).status).toBe(401);
    const res = await call(e, "GET", "/api/admin/users", { cookie: memberCookie });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    const p = await call(e, "PATCH", `/api/admin/users/x`, { cookie: memberCookie, body: { sttAllowed: true } });
    expect(p.status).toBe(403);
  });
});

describe("GET /api/admin/users", () => {
  it("lists users as AdminUser", async () => {
    const { admin, member, e, adminCookie } = await setup();
    const res = await call(e, "GET", "/api/admin/users", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ users: { userId: string; isAdmin: boolean; authType: string; sttAllowed: boolean }[] }>();
    expect(body.users.find((u) => u.userId === admin)).toMatchObject({ isAdmin: true, authType: "pat", sttAllowed: false });
    expect(body.users.find((u) => u.userId === member)).toMatchObject({ isAdmin: false, authType: "oauth" });
  });
});

describe("PATCH /api/admin/users/:id", () => {
  it("toggles stt_allowed and audits admin_change", async () => {
    const { admin, member, e, adminCookie } = await setup();
    const res = await call(e, "PATCH", `/api/admin/users/${member}`, { cookie: adminCookie, body: { sttAllowed: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: member, sttAllowed: true, isAdmin: false });
    expect((await db().select().from(users).where(eq(users.id, member)).get())?.sttAllowed).toBe(true);
    const audit = await db().select().from(auditLog).where(and(eq(auditLog.userId, admin), eq(auditLog.action, "admin_change")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain(member);

    const off = await call(e, "PATCH", `/api/admin/users/${member}`, { cookie: adminCookie, body: { sttAllowed: false } });
    expect(await off.json()).toMatchObject({ sttAllowed: false });
  });

  it("404 for an unknown user, 400 for anything but sttAllowed", async () => {
    const { e, adminCookie, member } = await setup();
    const r1 = await call(e, "PATCH", "/api/admin/users/nobody", { cookie: adminCookie, body: { sttAllowed: true } });
    expect(r1.status).toBe(404);
    expect(await r1.json()).toMatchObject({ error: { code: "not_found" } });
    const r2 = await call(e, "PATCH", `/api/admin/users/${member}`, { cookie: adminCookie, body: { sttAllowed: true, isAdmin: true } });
    expect(r2.status).toBe(400);
    const r3 = await call(e, "PATCH", `/api/admin/users/${member}`, { cookie: adminCookie, body: {} });
    expect(r3.status).toBe(400);
  });
});

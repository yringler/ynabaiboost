// routes/admin.ts — WP2 (DESIGN §7): /api/admin/*. Mounted at /api/admin; applies requireAdmin itself.
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { AdminUserPatchReq, AdminUsersRes } from "../../shared/api";
import { AdminUser } from "../../shared/schemas";
import { isAdmin } from "../auth/users";
import { users } from "../db/schema";
import type { AppEnv, UserRow } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validate";
import { requireJson } from "../middleware/requireJson";
import { requireAdmin } from "../middleware/session";

const toAdminUser = (env: Env, u: UserRow): AdminUser => ({
  userId: u.id, isAdmin: isAdmin(env, u.id), sttAllowed: u.sttAllowed,
  authType: u.authType, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt,
});

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

adminRoutes.get("/users", async (c) => {
  const rows = await c.var.db.select().from(users).orderBy(asc(users.createdAt));
  return c.json(AdminUsersRes.parse({ users: rows.map((u) => toAdminUser(c.env, u)) }));
});

/** STT toggle only; access itself is managed with the D16 vars. */
adminRoutes.patch("/users/:id", requireJson, validate("json", AdminUserPatchReq), async (c) => {
  const targetId = c.req.param("id");
  const { sttAllowed } = c.req.valid("json");
  const db = c.var.db;
  const exists = await db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).get();
  if (!exists) throw new AppError("not_found", "No such user");
  const [updated] = await db.batch([
    db.update(users).set({ sttAllowed }).where(eq(users.id, targetId)).returning(),
    auditStmt(db, {
      userId: c.var.userId, actor: "user", action: "admin_change",
      summary: `Server speech-to-text ${sttAllowed ? "enabled" : "disabled"} for user ${targetId}`,
    }),
  ]);
  const row = updated[0];
  if (!row) throw new AppError("not_found", "No such user");
  return c.json(AdminUser.parse(toAdminUser(c.env, row)));
});

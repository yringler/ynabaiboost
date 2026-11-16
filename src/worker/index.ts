// src/worker/index.ts — Hono app composition (DESIGN §4, WP1).
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { getDb } from "./db/client";
import type { AppEnv } from "./env";
import { runCron } from "./jobs/cycle";
import { AppError, errorHandler } from "./lib/errors";
import { originGuard } from "./middleware/originGuard";
import { requireAllowedUser, requireSession } from "./middleware/session";
import { accountRoutes } from "./routes/account";
import { activityRoutes } from "./routes/activity";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { editRoutes } from "./routes/edit";
import { intentRoutes } from "./routes/intents";
import { parseRoutes } from "./routes/parse";
import { reviewRoutes } from "./routes/reviews";
import { sttRoutes } from "./routes/stt";
import { syncRoutes } from "./routes/sync";

export const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.notFound(() => {
  throw new AppError("not_found", "Not found");
});
app.use("*", secureHeaders());
app.use("*", async (c, next) => {
  c.set("db", getDb(c.env));
  await next();
});
app.use("*", csrf({ origin: (origin, c) => origin === c.env.APP_ORIGIN }));
app.use("*", originGuard); // D20, non-GET only
app.route("/auth", authRoutes); // public (callback/login/logout)
app.use("/api/*", requireSession);
app.use("/api/*", requireAllowedUser); // id in ADMIN_USER_IDS ∪ ALLOWED_USER_IDS, else 403 not_allowed
// parseRoutes and editRoutes are mounted before intentRoutes so /api/intents/parse and /api/intents/edit* win over /api/intents/:id*.
for (const r of [accountRoutes, syncRoutes, parseRoutes, editRoutes, sttRoutes, intentRoutes, reviewRoutes, activityRoutes]) {
  app.route("/api", r);
}
app.route("/api/admin", adminRoutes); // adminRoutes applies requireAdmin itself

export default {
  fetch: app.fetch,
  scheduled(_ctrl, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;

// routes/account.ts — WP2 (DESIGN §7, §8): /api/me,/api/settings,/api/secrets/*,/api/account. Stub created by WP1: an empty router so index.ts compiles.
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const accountRoutes = new Hono<AppEnv>();

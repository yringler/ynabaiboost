// routes/sync.ts — WP3 (DESIGN §7, §8): /api/sync,/api/catalog,/api/plans. Stub created by WP1: an empty router so index.ts compiles.
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const syncRoutes = new Hono<AppEnv>();

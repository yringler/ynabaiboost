// src/worker/env.ts — DESIGN §8.1 (frozen)
import type { DrizzleD1Database } from "drizzle-orm/d1";
export type { BatchItem } from "drizzle-orm/batch"; // re-exported; every module uses BatchItem<"sqlite"> from here
import type * as schema from "./db/schema";
export type DB = DrizzleD1Database<typeof schema>;
export type UserRow = typeof schema.users.$inferSelect;
export type AppEnv = { Bindings: Env; Variables: { db: DB; userId: string; user: UserRow; sessionIdHash: string } };
export type Actor = "user" | "cron" | "app";

// src/worker/db/client.ts — DESIGN §8.1
import { drizzle } from "drizzle-orm/d1";
import type { DB } from "../env";
import * as schema from "./schema";

export function getDb(env: Env): DB {
  return drizzle(env.DB, { schema });
}

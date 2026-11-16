// Applies migrations/*.sql to the isolated D1 before each worker test file (DESIGN §13).
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

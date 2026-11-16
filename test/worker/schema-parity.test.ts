// Drizzle schema ↔ migrations parity (DESIGN §5): every Drizzle table selects cleanly, and its
// columns (names, NOT NULL, primary key membership) match PRAGMA table_info of the migrated D1.
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/worker/db/client";
import * as schema from "../../src/worker/db/schema";

const tables: SQLiteTable[] = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => v instanceof SQLiteTable);

interface PragmaCol { name: string; notnull: number; pk: number; type: string }

describe("schema parity", () => {
  it("covers every table in the migration", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    const sqlTables = results.map((r) => r.name).sort();
    const drizzleTables = tables.map((t) => getTableConfig(t).name).sort();
    expect(drizzleTables).toEqual(sqlTables);
  });

  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))("%s matches columns and selects", async (name, table) => {
    const db = getDb(env);
    await expect(db.select().from(table).limit(1)).resolves.toEqual([]);

    const { results } = await env.DB.prepare(`PRAGMA table_info(${name})`).all<PragmaCol>();
    const cfg = getTableConfig(table);
    const pkCols = new Set(cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)));
    const fromDrizzle = cfg.columns
      .map((c) => ({ name: c.name, notNull: c.notNull, pk: c.primary || pkCols.has(c.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const fromSql = results
      .map((c) => ({ name: c.name, notNull: c.notnull === 1 || (c.pk > 0 && c.type === "INTEGER"), pk: c.pk > 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // SQLite reports PRIMARY KEY TEXT columns as nullable; Drizzle marks primary keys notNull.
    const normalize = (cols: { name: string; notNull: boolean; pk: boolean }[]) =>
      cols.map((c) => ({ ...c, notNull: c.notNull || c.pk }));
    expect(normalize(fromDrizzle)).toEqual(normalize(fromSql));
  });
});

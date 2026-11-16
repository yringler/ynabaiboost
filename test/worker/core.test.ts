// WP1 core: ids, errors, audit.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "../../src/worker/db/client";
import { auditLog, users } from "../../src/worker/db/schema";
import type { AppEnv } from "../../src/worker/env";
import { auditStmt, toSnapshot } from "../../src/worker/lib/audit";
import { AppError, errorHandler } from "../../src/worker/lib/errors";
import { newId, newShortRef, randomToken, sha256Hex } from "../../src/worker/lib/ids";
import { validate } from "../../src/worker/lib/validate";

describe("ids", () => {
  it("newId is a UUID", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("newShortRef is 6 Crockford base32 chars", () => {
    for (let i = 0; i < 50; i++) expect(newShortRef()).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });
  it("randomToken is base64url of the requested size", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
  it("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("errorHandler", () => {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get("/app", () => {
    throw new AppError("ynab_subscription_lapsed", "lapsed");
  });
  app.get("/zod", () => {
    z.object({ a: z.string() }).parse({});
    return new Response();
  });
  app.get("/http", () => {
    throw new HTTPException(415, { message: "nope" });
  });
  app.get("/boom", () => {
    throw new Error("secret detail");
  });
  app.post("/json", validate("json", z.object({ n: z.int() })), (c) => c.json(c.req.valid("json")));

  it("maps AppError to ApiErrorBody with ERROR_STATUS", async () => {
    const res = await app.request("/app", {}, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "ynab_subscription_lapsed", message: "lapsed" } });
    expect(new AppError("ai_refusal").status).toBe(422);
  });
  it("maps ZodError to validation", async () => {
    const res = await app.request("/zod", {}, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation" } });
  });
  it("maps HTTPException by status", async () => {
    const res = await app.request("/http", {}, env);
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: { code: "unsupported_media" } });
  });
  it("hides unknown errors as internal", async () => {
    const res = await app.request("/boom", {}, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "Internal error" } });
  });
  it("validate() turns bad JSON bodies and wrong content types into validation errors", async () => {
    const ok = await app.request("/json", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"n":1}' }, env);
    expect(await ok.json()).toEqual({ n: 1 });
    const bad = await app.request("/json", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"n":"x"}' }, env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "validation" } });
    const form = await app.request("/json", { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"n":1}' }, env);
    expect(form.status).toBe(400);
    expect(await form.json()).toMatchObject({ error: { code: "validation" } });
  });
});

describe("audit", () => {
  it("toSnapshot keeps known flag colors only", () => {
    const t = { categoryId: "c1", approved: true, memo: "m", flagColor: "purple", isSplit: false };
    expect(toSnapshot(t)).toEqual(t);
    expect(toSnapshot({ ...t, flagColor: "pink" }).flagColor).toBeNull();
  });
  it("auditStmt can be batched and stores snapshots as JSON", async () => {
    const db = getDb(env);
    const now = 1_700_000_000_000;
    await db.insert(users).values({ id: "u1", authType: "pat", createdAt: now, lastSeenAt: now });
    const before = toSnapshot({ categoryId: null, approved: false, memo: null, flagColor: null, isSplit: false });
    const after = toSnapshot({ categoryId: "c1", approved: true, memo: "x [aib:ABC123]", flagColor: "purple", isSplit: false });
    await db.batch([
      auditStmt(db, { userId: "u1", actor: "cron", action: "txn_categorized", summary: "cat", ynabTxnId: "t1", before, after }, now),
      auditStmt(db, { userId: "u1", actor: "user", action: "login", summary: "hi" }, now + 1),
    ]);
    const rows = await db.select().from(auditLog).orderBy(auditLog.at);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.afterJson!)).toEqual(after);
    expect(rows[1]).toMatchObject({ action: "login", beforeJson: null, intentId: null });
  });
  it("auditStmt refuses txn rows without snapshots", () => {
    const db = getDb(env);
    expect(() => auditStmt(db, { userId: "u1", actor: "app", action: "txn_split", summary: "x" })).toThrow();
  });
});

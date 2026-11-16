// WP2: settings storage, /api/settings, /api/me, Anthropic key endpoints and getAnthropicKey.
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/schemas";
import { getAnthropicKey } from "../../src/worker/auth/anthropicKey";
import { getSecret, putSecret } from "../../src/worker/auth/secrets";
import { getSettings, updateSettings } from "../../src/worker/auth/settings";
import { auditLog, syncState, userSettings } from "../../src/worker/db/schema";
import { call, db, envWith, loadFreshApp, seedSession, seedUser, uid } from "./wp2-helpers";

// Fake the open-intent counts for /api/me.
const counts = vi.hoisted(() => ({ open: { pending: 4, stale: 1, review: 2 }, fail: false, args: [] as unknown[][] }));
vi.mock("../../src/worker/engine/reconcile", async (orig) => ({
  ...(await orig<typeof import("../../src/worker/engine/reconcile")>()),
  countOpen: async (...a: unknown[]) => {
    counts.args.push(a.slice(1));
    if (counts.fail) throw new Error("boom");
    return counts.open;
  },
}));

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await loadFreshApp();
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const e = envWith({ ALLOWED_USER_IDS: "*" });
const COUNT_TOKENS = "https://api.anthropic.com/v1/messages/count_tokens";
const KEY = "sk-ant-api03-test-key";

async function loggedIn() {
  const u = uid();
  await seedUser(u);
  const s = await seedSession(u);
  return { u, cookie: s.cookie };
}

describe("getSettings / updateSettings", () => {
  it("defaults when no row, merges patches, validates", async () => {
    const u = uid();
    await seedUser(u);
    expect(await getSettings(db(), u)).toEqual(DEFAULT_SETTINGS);
    const s1 = await updateSettings(db(), u, { timezone: "America/New_York", staleAfterDays: 20 });
    expect(s1).toMatchObject({ timezone: "America/New_York", staleAfterDays: 20, autoApproveMatches: true });
    expect(await getSettings(db(), u)).toEqual(s1);
    await expect(updateSettings(db(), u, { staleAfterDays: 1 })).rejects.toThrow();
    expect((await getSettings(db(), u)).staleAfterDays).toBe(20);
  });

  it("falls back to defaults for corrupt JSON and drops invalid stored fields", async () => {
    const u = uid();
    await seedUser(u);
    await db().insert(userSettings).values({ userId: u, json: "{not json", updatedAt: 1 });
    expect(await getSettings(db(), u)).toEqual(DEFAULT_SETTINGS);
    await db().update(userSettings).set({ json: JSON.stringify({ staleAfterDays: 999, timezone: "Europe/Paris" }) }).where(eq(userSettings.userId, u));
    expect(await getSettings(db(), u)).toMatchObject({ staleAfterDays: DEFAULT_SETTINGS.staleAfterDays, timezone: "Europe/Paris" });
  });

  it("changing planId resets that plan's sync_state and clears defaultAccountId", async () => {
    const u = uid();
    await seedUser(u);
    await updateSettings(db(), u, { planId: "p1", defaultAccountId: "acc1" });
    await db().insert(syncState).values([
      { userId: u, planId: "p1", serverKnowledge: 10 },
      { userId: u, planId: "p2", serverKnowledge: 20 },
    ]);
    const s = await updateSettings(db(), u, { planId: "p2" });
    expect(s).toMatchObject({ planId: "p2", defaultAccountId: null });
    const rows = await db().select().from(syncState).where(eq(syncState.userId, u));
    expect(rows.map((r) => r.planId)).toEqual(["p1"]);
    // same plan again: nothing reset, explicit account kept
    await db().insert(syncState).values({ userId: u, planId: "p2", serverKnowledge: 30 });
    await updateSettings(db(), u, { planId: "p2", defaultAccountId: "acc9" });
    expect(await db().select().from(syncState).where(and(eq(syncState.userId, u), eq(syncState.planId, "p2")))).toHaveLength(1);
    expect((await getSettings(db(), u)).defaultAccountId).toBe("acc9");
  });
});

describe("/api/settings", () => {
  it("GET returns defaults; PATCH merges, audits changed keys, returns SettingsShape", async () => {
    const { u, cookie } = await loggedIn();
    const g = await call(e, "GET", "/api/settings", { cookie });
    expect(await g.json()).toEqual(DEFAULT_SETTINGS);
    const p = await call(e, "PATCH", "/api/settings", { cookie, body: { aiDataConsent: true, voiceMode: "server", flagColor: null } });
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ aiDataConsent: true, voiceMode: "server", flagColor: null });
    const audit = await db().select().from(auditLog).where(and(eq(auditLog.userId, u), eq(auditLog.action, "settings_changed")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toBe("Settings changed: flagColor, voiceMode, aiDataConsent");
  });

  it("PATCH rejects unknown keys, bad values and non-JSON bodies with ApiErrorBody validation", async () => {
    const { cookie } = await loggedIn();
    for (const body of [{ nope: 1 }, { staleAfterDays: 2 }, { flagColor: "pink" }]) {
      const res = await call(e, "PATCH", "/api/settings", { cookie, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "validation" } });
    }
    const res = await call(e, "PATCH", "/api/settings", { cookie, body: { timezone: "UTC" }, headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/me", () => {
  it("assembles user, settings, plan, counts and last sync from sync_state", async () => {
    const { u, cookie } = await loggedIn();
    counts.fail = false;
    counts.args = [];
    await updateSettings(db(), u, { planId: "plan-1", timezone: "UTC" });
    await db().insert(syncState).values({
      userId: u, planId: "plan-1", planName: "Home", currencyIso: "EUR", currencyDecimals: 2,
      lastCycleAt: 1_700_000_000_000, lastError: "ynab_subscription_lapsed: ended",
    });
    await putSecret(env, db(), u, "anthropic", KEY);
    const res = await call(envWith({ ALLOWED_USER_IDS: "*", ADMIN_USER_IDS: u, YNAB_CLIENT_ID: "" }), "GET", "/api/me", { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: u, isAdmin: true, authType: "pat", needsReauth: false, sttAllowed: false, hasAnthropicKey: true,
      oauthAvailable: false,
      settings: { ...DEFAULT_SETTINGS, planId: "plan-1", timezone: "UTC" },
      plan: { id: "plan-1", name: "Home", currency: { isoCode: "EUR", decimalDigits: 2 } },
      counts: { pending: 4, stale: 1, review: 2 },
      lastSyncError: "ynab_subscription_lapsed: ended",
      lastSyncAt: 1_700_000_000_000,
    });
    expect(counts.args[0]?.[0]).toBe(u);
    expect(counts.args[0]?.[1]).toBe("plan-1");
    expect(counts.args[0]?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("no plan → plan null and zero counts; failing counts never break /api/me", async () => {
    const { u, cookie } = await loggedIn();
    const r1 = await call(e, "GET", "/api/me", { cookie });
    expect(await r1.json()).toMatchObject({ plan: null, counts: { pending: 0, stale: 0, review: 0 }, lastSyncAt: null });
    await updateSettings(db(), u, { planId: "plan-x" });
    counts.fail = true;
    const r2 = await call(e, "GET", "/api/me", { cookie });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({
      plan: { id: "plan-x", name: "", currency: { isoCode: "USD", decimalDigits: 2 } },
      counts: { pending: 0, stale: 0, review: 0 },
    });
    counts.fail = false;
  });
});

describe("/api/secrets/anthropic", () => {
  it("PUT validates the key with countTokens, stores it sealed, audits", async () => {
    const { u, cookie } = await loggedIn();
    let seen: { key: string | null; body: unknown } | undefined;
    network.use(
      http.post(COUNT_TOKENS, async ({ request }) => {
        // SDK 1.9 sends the key as `Authorization: Bearer`; older versions used `x-api-key`.
        const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
        seen = { key, body: await request.json() };
        return HttpResponse.json({ input_tokens: 8 });
      }),
    );
    const res = await call(e, "PUT", "/api/secrets/anthropic", { cookie, body: { apiKey: KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen?.key).toBe(KEY);
    expect(seen?.body).toMatchObject({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] });
    expect((await getSecret(env, db(), u, "anthropic"))?.value).toBe(KEY);
    const audit = await db().select().from(auditLog).where(and(eq(auditLog.userId, u), eq(auditLog.action, "secret_changed")));
    expect(audit.map((a) => a.summary)).toEqual(["Anthropic API key saved"]);
    expect(audit[0]!.summary).not.toContain(KEY);
  });

  it("PUT with a key Anthropic rejects → 409 anthropic_key_invalid, nothing stored", async () => {
    const { u, cookie } = await loggedIn();
    network.use(
      http.post(COUNT_TOKENS, () =>
        HttpResponse.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })),
    );
    const res = await call(e, "PUT", "/api/secrets/anthropic", { cookie, body: { apiKey: KEY } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "anthropic_key_invalid" } });
    expect(await getSecret(env, db(), u, "anthropic")).toBeNull();
  });

  it("PUT when Anthropic is down → 503 ai_unavailable", async () => {
    const { cookie } = await loggedIn();
    network.use(
      http.post(COUNT_TOKENS, () => HttpResponse.json({ type: "error", error: { type: "overloaded_error", message: "x" } }, { status: 529 })),
    );
    const res = await call(e, "PUT", "/api/secrets/anthropic", { cookie, body: { apiKey: KEY } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "ai_unavailable" } });
  });

  it("PUT rejects keys without the sk-ant- prefix", async () => {
    const { cookie } = await loggedIn();
    const res = await call(e, "PUT", "/api/secrets/anthropic", { cookie, body: { apiKey: "nope" } });
    expect(res.status).toBe(400);
  });

  it("DELETE removes the key", async () => {
    const { u, cookie } = await loggedIn();
    await putSecret(env, db(), u, "anthropic", KEY);
    const res = await call(e, "DELETE", "/api/secrets/anthropic", { cookie });
    expect(res.status).toBe(200);
    expect(await getSecret(env, db(), u, "anthropic")).toBeNull();
  });
});

describe("getAnthropicKey", () => {
  it("requires consent, then a key", async () => {
    const u = uid();
    await seedUser(u);
    await expect(getAnthropicKey(env, db(), u)).rejects.toMatchObject({ code: "ai_consent_required" });
    await putSecret(env, db(), u, "anthropic", KEY);
    await expect(getAnthropicKey(env, db(), u)).rejects.toMatchObject({ code: "ai_consent_required" });
    await updateSettings(db(), u, { aiDataConsent: true });
    expect(await getAnthropicKey(env, db(), u)).toBe(KEY);
    await db().delete(userSettings).where(eq(userSettings.userId, u));
    await updateSettings(db(), u, { aiDataConsent: true });
    await putSecret(env, db(), u, "anthropic", KEY);
    const v = uid();
    await seedUser(v);
    await updateSettings(db(), v, { aiDataConsent: true });
    await expect(getAnthropicKey(env, db(), v)).rejects.toMatchObject({ code: "anthropic_key_missing" });
  });
});

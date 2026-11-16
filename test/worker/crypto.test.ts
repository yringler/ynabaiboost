// WP2: AES-GCM envelope (D7) and encrypted secrets storage.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { open, seal } from "../../src/worker/auth/crypto";
import { deleteSecrets, getSecret, hasSecret, putSecret } from "../../src/worker/auth/secrets";
import { userSecrets } from "../../src/worker/db/schema";
import { AppError } from "../../src/worker/lib/errors";
import { db, envWith, seedUser, uid } from "./wp2-helpers";

const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("seal/open", () => {
  it("round-trips and uses the v1.<iv>.<ct> base64url format", async () => {
    const sealed = await seal(env, "secret-ünïcode-🔑", "u1:anthropic");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("secret");
    expect(await open(env, sealed, "u1:anthropic")).toBe("secret-ünïcode-🔑");
  });

  it("uses a fresh IV each time", async () => {
    const a = await seal(env, "same", "aad");
    const b = await seal(env, "same", "aad");
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("rejects a different AAD (swapped between users or fields)", async () => {
    const sealed = await seal(env, "tok", "u1:ynab_pat");
    await expect(open(env, sealed, "u2:ynab_pat")).rejects.toMatchObject({ code: "internal" });
    await expect(open(env, sealed, "u1:anthropic")).rejects.toBeInstanceOf(AppError);
  });

  it("rejects tampered ciphertext and IV", async () => {
    const sealed = await seal(env, "tok", "aad");
    const [v, iv, ct] = sealed.split(".") as [string, string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    await expect(open(env, `${v}.${iv}.${flip(ct)}`, "aad")).rejects.toMatchObject({ code: "internal" });
    await expect(open(env, `${v}.${flip(iv)}.${ct}`, "aad")).rejects.toMatchObject({ code: "internal" });
  });

  it("rejects malformed envelopes and unknown versions", async () => {
    for (const bad of ["", "v1", "v1.a", "v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA", "v1.!!.??", "v1.AAAA.AAAAAAAAAAAAAAAAAAAAAA"]) {
      await expect(open(env, bad, "aad")).rejects.toMatchObject({ code: "internal" });
    }
  });

  it("rejects a value sealed under another master key", async () => {
    const sealed = await seal(envWith({ ENCRYPTION_KEY: OTHER_KEY }), "tok", "aad");
    await expect(open(env, sealed, "aad")).rejects.toMatchObject({ code: "internal" });
    expect(await open(envWith({ ENCRYPTION_KEY: OTHER_KEY }), sealed, "aad")).toBe("tok");
  });

  it("refuses a master key that is not 32 bytes", async () => {
    await expect(seal(envWith({ ENCRYPTION_KEY: btoa("short") }), "x", "aad")).rejects.toMatchObject({ code: "internal" });
  });
});

describe("secrets", () => {
  it("put/get/delete with AAD = userId:kind; stored value is sealed", async () => {
    const u = uid();
    await seedUser(u);
    expect(await getSecret(env, db(), u, "anthropic")).toBeNull();
    await putSecret(env, db(), u, "anthropic", "sk-ant-abc");
    await putSecret(env, db(), u, "ynab_access", "acc-1", 12345);
    expect(await getSecret(env, db(), u, "anthropic")).toEqual({ value: "sk-ant-abc", expiresAt: null });
    expect(await getSecret(env, db(), u, "ynab_access")).toEqual({ value: "acc-1", expiresAt: 12345 });
    expect(await hasSecret(db(), u, "anthropic")).toBe(true);

    const rows = await db().select().from(userSecrets);
    const mine = rows.filter((r) => r.userId === u);
    expect(mine).toHaveLength(2);
    for (const r of mine) {
      expect(r.sealed).toMatch(/^v1\./);
      expect(r.sealed).not.toContain("sk-ant");
    }

    // upsert replaces
    await putSecret(env, db(), u, "ynab_access", "acc-2", 999);
    expect(await getSecret(env, db(), u, "ynab_access")).toEqual({ value: "acc-2", expiresAt: 999 });

    await deleteSecrets(db(), u, ["anthropic"]);
    expect(await getSecret(env, db(), u, "anthropic")).toBeNull();
    expect(await getSecret(env, db(), u, "ynab_access")).not.toBeNull();
    await deleteSecrets(db(), u);
    expect(await getSecret(env, db(), u, "ynab_access")).toBeNull();
  });

  it("a row copied to another user does not decrypt", async () => {
    const a = uid();
    const b = uid();
    await seedUser(a);
    await seedUser(b);
    await putSecret(env, db(), a, "ynab_pat", "pat-of-a");
    const row = (await db().select().from(userSecrets)).find((r) => r.userId === a);
    await db().insert(userSecrets).values({ ...row!, userId: b });
    await expect(getSecret(env, db(), b, "ynab_pat")).rejects.toMatchObject({ code: "internal" });
  });
});

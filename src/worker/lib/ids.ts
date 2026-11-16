// src/worker/lib/ids.ts — DESIGN §8.1
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newId(): string {
  return crypto.randomUUID();
}

/** 6 chars, Crockford base32 (used in the memo tag [aib:XXXXXX]). */
export function newShortRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

/** base64url, default 32 bytes. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

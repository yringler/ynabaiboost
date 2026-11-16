// auth/crypto.ts — WP2 (DESIGN §8.2, D7). AES-256-GCM envelope for secrets at rest.
// Format: "v1.<iv_b64url>.<ct_b64url>" (12-byte random IV; ct includes the 16-byte GCM tag).
// AAD binds a ciphertext to its owner and field (`userId:kind`), so it cannot be swapped between rows.
import { AppError } from "../lib/errors";

const VERSION = "v1";
const IV_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Imported keys, cached per isolate and keyed by the raw secret string (supports key changes across envs in tests). */
const keyCache = new Map<string, Promise<CryptoKey>>();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeMasterKey(b64: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(b64.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  } catch {
    throw new AppError("internal", "ENCRYPTION_KEY is not valid base64");
  }
  if (raw.length !== 32) throw new AppError("internal", "ENCRYPTION_KEY must be 32 bytes");
  return raw;
}

function getKey(env: Env): Promise<CryptoKey> {
  const secret = env.ENCRYPTION_KEY;
  let p = keyCache.get(secret);
  if (!p) {
    p = (async () => crypto.subtle.importKey("raw", decodeMasterKey(secret), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]))();
    p.catch(() => keyCache.delete(secret));
    keyCache.set(secret, p);
  }
  return p;
}

export async function seal(env: Env, plaintext: string, aad: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext));
  return `${VERSION}.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

/** Throws AppError('internal') on tamper, wrong AAD, wrong key or a malformed envelope. Never includes secret material in the message. */
export async function open(env: Env, sealed: string, aad: string): Promise<string> {
  const key = await getKey(env);
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new AppError("internal", "Sealed secret has an unknown format");
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = b64urlDecode(parts[1] ?? "");
    ct = b64urlDecode(parts[2] ?? "");
  } catch {
    throw new AppError("internal", "Sealed secret has an unknown format");
  }
  if (iv.length !== IV_BYTES || ct.length < 16) throw new AppError("internal", "Sealed secret has an unknown format");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, ct);
    return dec.decode(pt);
  } catch (e) {
    throw new AppError("internal", "Sealed secret could not be decrypted", e);
  }
}

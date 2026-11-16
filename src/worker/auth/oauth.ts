// auth/oauth.ts — WP2: YNAB OAuth (Authorization Code + PKCE) via oauth4webapi (DESIGN D5, §12 WP2).
// No frozen §8 contract: routes/auth.ts and auth/ynabToken.ts are the only consumers.
// If spike S5 / real use shows YNAB's token response trips oauth4webapi's strict checks, replace the
// bodies of exchangeCode/refreshTokens with two hand-rolled form POSTs; the exports stay the same.
import * as oauth from "oauth4webapi";

export const YNAB_AUTHORIZE_URL = "https://app.ynab.com/oauth/authorize";
export const YNAB_TOKEN_URL = "https://app.ynab.com/oauth/token";

export const YNAB_AS: oauth.AuthorizationServer = {
  issuer: "https://app.ynab.com",
  authorization_endpoint: YNAB_AUTHORIZE_URL,
  token_endpoint: YNAB_TOKEN_URL,
};

export interface TokenSet {
  accessToken: string;
  /** null when the response carried none (the caller keeps the previous one). */
  refreshToken: string | null;
  /** epoch ms; null when the server gave no expires_in. */
  expiresAt: number | null;
}

/** OAuth is offered only when both the client id and a real secret are configured (DESIGN §7 /auth/config). */
export function oauthAvailable(env: Env): boolean {
  return env.YNAB_CLIENT_ID.trim() !== "" && env.YNAB_CLIENT_SECRET.trim() !== "" && env.YNAB_CLIENT_SECRET !== "disabled";
}

export function redirectUri(env: Env): string {
  return `${env.APP_ORIGIN.replace(/\/+$/, "")}/auth/ynab/callback`;
}

const client = (env: Env): oauth.Client => ({ client_id: env.YNAB_CLIENT_ID.trim() });
const clientAuth = (env: Env): oauth.ClientAuth => oauth.ClientSecretPost(env.YNAB_CLIENT_SECRET);

export interface AuthStart { state: string; codeVerifier: string; url: string }

/** Fresh state + PKCE verifier and the authorize URL. Never requests scope=read-only (we write to YNAB). */
export async function startAuthorization(env: Env): Promise<AuthStart> {
  const state = oauth.generateRandomState();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const url = new URL(YNAB_AUTHORIZE_URL);
  url.searchParams.set("client_id", client(env).client_id);
  url.searchParams.set("redirect_uri", redirectUri(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { state, codeVerifier, url: url.href };
}

function toTokenSet(r: oauth.TokenEndpointResponse, now: number): TokenSet {
  return {
    accessToken: r.access_token,
    refreshToken: typeof r.refresh_token === "string" && r.refresh_token !== "" ? r.refresh_token : null,
    expiresAt: typeof r.expires_in === "number" ? now + r.expires_in * 1000 : null,
  };
}

/** Exchanges the authorization code. The caller has already compared `state` (constant time), so
 *  oauth4webapi's own state check is skipped; it still rejects `?error=` responses (AuthorizationResponseError). */
export async function exchangeCode(env: Env, callbackUrl: URL, codeVerifier: string): Promise<TokenSet> {
  const params = oauth.validateAuthResponse(YNAB_AS, client(env), callbackUrl, oauth.skipStateCheck);
  const now = Date.now();
  const res = await oauth.authorizationCodeGrantRequest(YNAB_AS, client(env), clientAuth(env), params, redirectUri(env), codeVerifier);
  return toTokenSet(await oauth.processAuthorizationCodeResponse(YNAB_AS, client(env), res), now);
}

/** Refresh grant. Throws oauth4webapi's ResponseBodyError on an OAuth error body (see isInvalidGrant). */
export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenSet> {
  const now = Date.now();
  const res = await oauth.refreshTokenGrantRequest(YNAB_AS, client(env), clientAuth(env), refreshToken);
  return toTokenSet(await oauth.processRefreshTokenResponse(YNAB_AS, client(env), res), now);
}

/** The refresh token is dead and the user must sign in again (DESIGN §8.2: invalid_grant or 401). */
export function isInvalidGrant(e: unknown): boolean {
  if (!(e instanceof oauth.ResponseBodyError)) return false;
  return e.error === "invalid_grant" || e.status === 401;
}

export { AuthorizationResponseError, ResponseBodyError } from "oauth4webapi";

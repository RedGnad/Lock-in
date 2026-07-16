import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress } from "viem";

/**
 * The Strava OAuth handshake: the authorize URL, the signed `state`, and the token exchange.
 *
 * `state` is the only thing standing between an athlete and a CSRF-style graft, where an attacker gets
 * their own Strava account attached to someone else's wallet. It is therefore signed (HMAC over the wallet
 * plus a nonce plus an expiry) rather than merely random: the callback can then prove which wallet started
 * the flow without trusting a cookie or a query parameter.
 */

const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const REVOKE_URL = "https://www.strava.com/oauth/revoke";
const DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize";

/**
 * `activity:read_all` rather than `activity:read`: an athlete who keeps activities private is common, and
 * they must not discover that their runs are invisible only after staking.
 */
export const STRAVA_SCOPE = "activity:read_all";
const STATE_TTL_MS = 10 * 60_000;

export class StravaOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaOAuthError";
  }
}

function reject(message: string): never {
  throw new StravaOAuthError(message);
}

export function stravaClientId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.STRAVA_CLIENT_ID?.trim();
  if (!value) reject("STRAVA_CLIENT_ID is not configured");
  return value;
}

function stravaClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.STRAVA_CLIENT_SECRET?.trim();
  if (!value) reject("STRAVA_CLIENT_SECRET is not configured");
  return value;
}

function stateSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SESSION_SIGNING_SECRET?.trim();
  if (!value || value.length < 32) reject("SESSION_SIGNING_SECRET must contain at least 32 characters");
  return value;
}

type StatePayload = { wallet: string; nonce: string; exp: number };

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function issueStravaState(
  walletAddress: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): string {
  if (!isAddress(walletAddress)) reject("Invalid wallet address");
  const payload: StatePayload = {
    wallet: getAddress(walletAddress),
    nonce: randomBytes(16).toString("base64url"),
    exp: nowMs + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, stateSecret(env))}`;
}

export type VerifiedState = Readonly<{ wallet: string; nonceHash: string; expiresAt: Date }>;

/**
 * Returns who started the flow, plus what the caller needs to burn the state.
 *
 * The signature proves the state was not modified. It CANNOT prove the state was not replayed: a stolen
 * but still-valid state verifies perfectly. The nonce hash is returned so the callback can record it as
 * spent, which is the part that actually stops a replay.
 */
export function verifyStravaState(
  state: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): VerifiedState {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) reject("Malformed OAuth state");

  const expected = sign(encoded, stateSecret(env));
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  // Constant time, and length-checked first: timingSafeEqual throws on a length mismatch.
  if (given.length !== want.length || !timingSafeEqual(given, want)) reject("OAuth state signature mismatch");

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return reject("Malformed OAuth state payload");
  }
  if (!payload.wallet || !isAddress(payload.wallet)) reject("OAuth state carries no wallet");
  if (typeof payload.nonce !== "string" || payload.nonce.length === 0) reject("OAuth state carries no nonce");
  if (!Number.isSafeInteger(payload.exp) || payload.exp < nowMs) reject("OAuth state has expired");
  return {
    wallet: getAddress(payload.wallet),
    // Hashed, so a database read never reveals a live nonce.
    nonceHash: createHash("sha256").update(payload.nonce).digest("hex"),
    expiresAt: new Date(payload.exp),
  };
}

export function stravaAuthorizeUrl(input: {
  state: string;
  redirectUri: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", stravaClientId(input.env));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  // Without `force`, Strava silently reuses a narrower prior grant and the athlete never sees the scope
  // they are actually giving.
  url.searchParams.set("approval_prompt", "force");
  url.searchParams.set("scope", STRAVA_SCOPE);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type StravaTokens = Readonly<{
  athleteId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
}>;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  athlete?: { id?: number };
};

async function postToken(body: Record<string, string>, env: NodeJS.ProcessEnv): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: stravaClientId(env),
      client_secret: stravaClientSecret(env),
      ...body,
    }),
  });
  if (!response.ok) {
    // Strava echoes the request in its errors; only the status crosses this boundary.
    reject(`Strava rejected the token request (${response.status})`);
  }
  return (await response.json()) as TokenResponse;
}

function readTokens(payload: TokenResponse, grantedScopes: string): StravaTokens {
  if (!payload.access_token || !payload.refresh_token || !payload.expires_at) {
    reject("Strava returned an incomplete token response");
  }
  return {
    athleteId: String(payload.athlete?.id ?? ""),
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessTokenExpiresAt: new Date(payload.expires_at * 1_000),
    scopes: grantedScopes,
  };
}

/** Exchanges the one-time code from the callback. `scope` is what the athlete actually granted. */
export async function exchangeStravaCode(input: {
  code: string;
  scope: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StravaTokens> {
  const env = input.env ?? process.env;
  const payload = await postToken({ code: input.code, grant_type: "authorization_code" }, env);
  const tokens = readTokens(payload, input.scope);
  if (!tokens.athleteId) reject("Strava returned no athlete id");
  return tokens;
}

/**
 * Refreshes an access token. Strava ROTATES refresh tokens: the response may carry a new one and the old
 * one stops working, so the caller must persist whatever comes back here, atomically.
 */
export async function refreshStravaTokens(
  refreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresAt: Date }> {
  const payload = await postToken({ refresh_token: refreshToken, grant_type: "refresh_token" }, env);
  const tokens = readTokens(payload, "");
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
  };
}

/**
 * Revokes the athlete's grant at Strava.
 *
 * `/oauth/revoke` is the current endpoint: it authenticates the APPLICATION with HTTP Basic
 * client_id:client_secret and takes the token in the form body. The older `/oauth/deauthorize` takes the
 * athlete's access token instead, and is kept as a fallback so a revoke still lands if the new endpoint
 * is unavailable to this application.
 *
 * Best effort by design: the caller must delete the local connection whether or not this succeeds. The
 * athlete asked to be disconnected, and an outage at Strava must not keep their tokens in our database.
 */
export async function revokeStravaGrant(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ revoked: boolean; via?: "revoke" | "deauthorize" }> {
  try {
    const basic = Buffer.from(`${stravaClientId(env)}:${stravaClientSecret(env)}`, "utf8").toString("base64");
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: accessToken }),
    });
    if (response.ok) return { revoked: true, via: "revoke" };
  } catch {
    // Fall through: a network failure here must not stop the local delete.
  }
  try {
    const response = await fetch(DEAUTHORIZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: accessToken }),
    });
    if (response.ok) return { revoked: true, via: "deauthorize" };
  } catch {
    // Same: report failure, never throw.
  }
  return { revoked: false };
}

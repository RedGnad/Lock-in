import { neon } from "@neondatabase/serverless";
import { getAddress, isAddress } from "viem";
import { decryptStravaToken, encryptStravaToken } from "./strava-crypto";

/**
 * Server-only store for Strava OAuth tokens.
 *
 * Nothing here is ever returned to a browser. A caller asks for a usable access token and gets a string;
 * the refresh token stays inside this module. Rows are keyed by the checksummed wallet address, so a
 * connection belongs to a wallet, and `athlete_id` is unique so one Strava account cannot back two wallets.
 */

export class StravaTokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaTokenStoreError";
  }
}

export type StravaConnection = Readonly<{
  walletAddress: string;
  athleteId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
}>;

/** The pooled URL is for queries; DDL runs over the direct one (see scripts/migrate-strava-tokens.ts). */
function sql() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new StravaTokenStoreError("DATABASE_URL is not configured");
  return neon(url);
}

/**
 * Proves the database actually answers and carries our tables.
 *
 * Checking that DATABASE_URL is set proves nothing: a wrong URL, an unmigrated database or a Neon outage
 * all pass that test and then fail at the athlete's first check-in, after they have staked.
 */
export async function stravaStorageReachable(): Promise<boolean> {
  try {
    const query = sql();
    const rows = (await query`
      SELECT count(*)::int AS present FROM information_schema.tables
      WHERE table_name IN ('strava_connections', 'strava_oauth_states')
    `) as { present: number }[];
    return rows[0]?.present === 2;
  } catch {
    return false;
  }
}

export function normaliseWallet(walletAddress: string): string {
  if (!isAddress(walletAddress)) throw new StravaTokenStoreError("Invalid wallet address");
  return getAddress(walletAddress);
}

export const STRAVA_TOKENS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS strava_connections (
    wallet_address          text PRIMARY KEY,
    athlete_id              text NOT NULL,
    encrypted_refresh_token text NOT NULL,
    encrypted_access_token  text NOT NULL,
    access_token_expires_at timestamptz NOT NULL,
    scopes                  text NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    revoked_at              timestamptz
  );
  -- One Strava account cannot back two wallets. Partial, so a revoked connection frees the athlete to
  -- reconnect from another wallet without deleting the audit row.
  CREATE UNIQUE INDEX IF NOT EXISTS strava_connections_athlete_active
    ON strava_connections (athlete_id) WHERE revoked_at IS NULL;

  -- One authorisation per state. The HMAC proves a state was not modified; only a record of what has
  -- already been used can stop the same valid state being replayed inside its window.
  CREATE TABLE IF NOT EXISTS strava_oauth_states (
    nonce_hash  text PRIMARY KEY,
    wallet_address text NOT NULL,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz NOT NULL DEFAULT now()
  );
`;

/**
 * Records a state nonce as used, and reports whether it had already been used.
 *
 * The INSERT is the lock: two callbacks racing with the same state produce one insert and one conflict,
 * so exactly one of them can proceed. Expired rows are cleared opportunistically rather than by a cron.
 */
export async function consumeStravaState(input: {
  nonceHash: string;
  walletAddress: string;
  expiresAt: Date;
}): Promise<boolean> {
  const query = sql();
  await query`DELETE FROM strava_oauth_states WHERE expires_at < now()`;
  const rows = (await query`
    INSERT INTO strava_oauth_states (nonce_hash, wallet_address, expires_at)
    VALUES (${input.nonceHash}, ${normaliseWallet(input.walletAddress)}, ${input.expiresAt.toISOString()})
    ON CONFLICT (nonce_hash) DO NOTHING
    RETURNING nonce_hash
  `) as { nonce_hash: string }[];
  return rows.length === 1;
}

/** Upserts a connection. Called on first authorisation and on every reconnect. */
export async function saveStravaConnection(input: {
  walletAddress: string;
  athleteId: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
}): Promise<void> {
  const wallet = normaliseWallet(input.walletAddress);
  const query = sql();
  await query`
    INSERT INTO strava_connections (
      wallet_address, athlete_id, encrypted_refresh_token, encrypted_access_token,
      access_token_expires_at, scopes, revoked_at
    ) VALUES (
      ${wallet}, ${input.athleteId}, ${encryptStravaToken(input.refreshToken)},
      ${encryptStravaToken(input.accessToken)}, ${input.accessTokenExpiresAt.toISOString()},
      ${input.scopes}, NULL
    )
    ON CONFLICT (wallet_address) DO UPDATE SET
      athlete_id = EXCLUDED.athlete_id,
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      scopes = EXCLUDED.scopes,
      revoked_at = NULL,
      updated_at = now()
  `;
}

type ConnectionRow = {
  athlete_id: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string;
  access_token_expires_at: string;
  scopes: string;
};

async function readConnection(wallet: string): Promise<ConnectionRow | undefined> {
  const query = sql();
  const rows = (await query`
    SELECT athlete_id, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, scopes
    FROM strava_connections
    WHERE wallet_address = ${wallet} AND revoked_at IS NULL
  `) as ConnectionRow[];
  return rows[0];
}

export async function stravaConnectionStatus(
  walletAddress: string,
): Promise<{ connected: boolean; athleteId?: string; scopes?: string }> {
  const row = await readConnection(normaliseWallet(walletAddress));
  return row ? { connected: true, athleteId: row.athlete_id, scopes: row.scopes } : { connected: false };
}

/**
 * Replaces the stored pair with the one Strava just issued.
 *
 * Strava rotates refresh tokens: a refresh MAY return a new refresh token, and the old one stops working.
 * Writing both in a single statement is what keeps that atomic. Persisting the access token but not the
 * new refresh token would leave the connection alive until expiry and then dead forever, with no way back
 * except reconnecting.
 */
async function rotateTokens(input: {
  wallet: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
}): Promise<void> {
  const query = sql();
  await query`
    UPDATE strava_connections SET
      encrypted_refresh_token = ${encryptStravaToken(input.refreshToken)},
      encrypted_access_token = ${encryptStravaToken(input.accessToken)},
      access_token_expires_at = ${input.accessTokenExpiresAt.toISOString()},
      updated_at = now()
    WHERE wallet_address = ${input.wallet} AND revoked_at IS NULL
  `;
}

/**
 * Deletes the connection outright.
 *
 * Marking `revoked_at` and keeping the row would leave the athlete id, the scopes and both encrypted
 * tokens in the database after someone asked to be forgotten, which is not what disconnecting means and
 * not what the privacy page promises. The row goes.
 */
export async function deleteStravaConnection(walletAddress: string): Promise<void> {
  const query = sql();
  await query`DELETE FROM strava_connections WHERE wallet_address = ${normaliseWallet(walletAddress)}`;
}

/** Reads the refresh token for the revoke call. Server-only, and never surfaced to a caller. */
export async function readStravaRefreshTokenForRevoke(walletAddress: string): Promise<string | undefined> {
  const row = await readConnection(normaliseWallet(walletAddress));
  return row ? decryptStravaToken(row.encrypted_refresh_token) : undefined;
}

/**
 * Returns an access token that is valid now, refreshing it against Strava if needed.
 *
 * `refresh` is injected so the HTTP call lives in the Strava client and this module stays about storage.
 */
export async function getUsableStravaAccessToken(
  walletAddress: string,
  refresh: (refreshToken: string) => Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: Date;
  }>,
  now: Date = new Date(),
): Promise<StravaConnection> {
  const wallet = normaliseWallet(walletAddress);
  const row = await readConnection(wallet);
  if (!row) throw new StravaTokenStoreError("This wallet has no Strava connection");

  const expiresAt = new Date(row.access_token_expires_at);
  // Refresh a minute early: a token that expires mid-request is a failed check-in for the athlete.
  if (expiresAt.getTime() - now.getTime() > 60_000) {
    return {
      walletAddress: wallet,
      athleteId: row.athlete_id,
      accessToken: decryptStravaToken(row.encrypted_access_token),
      accessTokenExpiresAt: expiresAt,
      scopes: row.scopes,
    };
  }

  const refreshed = await refresh(decryptStravaToken(row.encrypted_refresh_token));
  await rotateTokens({
    wallet,
    refreshToken: refreshed.refreshToken,
    accessToken: refreshed.accessToken,
    accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
  });
  return {
    walletAddress: wallet,
    athleteId: row.athlete_id,
    accessToken: refreshed.accessToken,
    accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
    scopes: row.scopes,
  };
}

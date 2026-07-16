import "dotenv/config";
import { neon } from "@neondatabase/serverless";

/*
 * Read-only look at the Strava connection rows, for the OAuth production test.
 *
 * It NEVER prints a token, encrypted or not. It prints the envelope's shape and length instead, which is
 * what tells you the row is genuinely encrypted rather than holding a bare token: a v1 envelope is
 * `v1.<iv>.<authTag>.<ciphertext>`. The athlete id is truncated, because the point of this script is to
 * confirm the row exists and the two canary wallets resolve to two DIFFERENT athletes, not to copy a
 * Strava identity into a terminal log.
 *
 * Usage: pnpm strava:connections
 */

const url = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL is required");

const sql = neon(url);

function envelope(value: string): string {
  const parts = value.split(".");
  if (parts[0] !== "v1" || parts.length !== 4) return `NOT A v1 ENVELOPE (${parts.length} parts) — suspect`;
  return `v1 envelope, iv ${parts[1].length}c, tag ${parts[2].length}c, ciphertext ${parts[3].length}c`;
}

type Row = {
  wallet_address: string;
  athlete_id: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string;
  access_token_expires_at: string;
  scopes: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

const rows = (await sql.query(
  `SELECT wallet_address, athlete_id, encrypted_refresh_token, encrypted_access_token,
          access_token_expires_at, scopes, created_at, updated_at, revoked_at
     FROM strava_connections ORDER BY created_at`,
)) as Row[];

console.log(`strava_connections: ${rows.length} row(s)\n`);
for (const row of rows) {
  const expiresInSeconds = Math.round((Date.parse(row.access_token_expires_at) - Date.now()) / 1_000);
  console.log(`wallet        : ${row.wallet_address}`);
  console.log(`athlete       : ${row.athlete_id.slice(0, 4)}… (${row.athlete_id.length} digits)`);
  console.log(`scopes        : ${row.scopes}`);
  console.log(`refresh token : ${envelope(row.encrypted_refresh_token)}`);
  console.log(`access token  : ${envelope(row.encrypted_access_token)}`);
  console.log(`access expires: ${row.access_token_expires_at} (${expiresInSeconds}s from now)`);
  console.log(`created       : ${row.created_at}`);
  // Compare the instants, not the objects: node-postgres hands back two distinct Date instances, so `!==`
  // is always true and would report a rotation on every freshly created row.
  const rotated = Date.parse(String(row.updated_at)) !== Date.parse(String(row.created_at));
  console.log(`updated       : ${row.updated_at}${rotated ? " (token has rotated since connecting)" : " (not refreshed yet)"}`);
  console.log(`revoked       : ${row.revoked_at ?? "no"}\n`);
}

const athletes = new Set(rows.map((row) => row.athlete_id));
if (rows.length > 1) {
  // The canary needs two SEPARATE athletes. One Strava account backing both wallets would make the
  // two-participant test meaningless, and the escrow's one-identity-per-Lock rule would reject it anyway.
  console.log(athletes.size === rows.length
    ? `✓ ${rows.length} wallets, ${athletes.size} distinct athletes`
    : `✗ ${rows.length} wallets but only ${athletes.size} distinct athletes — the same Strava account is connected twice`);
}

const states = (await sql.query(
  `SELECT count(*)::int AS total, count(*) FILTER (WHERE expires_at > now())::int AS live FROM strava_oauth_states`,
)) as { total: number; live: number }[];
console.log(`\nstrava_oauth_states: ${states[0].total} burnt nonce(s), ${states[0].live} still inside their window`);

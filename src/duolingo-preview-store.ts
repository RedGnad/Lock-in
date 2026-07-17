import "server-only";
import { neon } from "@neondatabase/serverless";
import type { Hex } from "viem";

/**
 * Server-side state for the Duolingo Live Proof Beta.
 *
 * The baseline CANNOT live in the browser. The whole claim of DUOLINGO_ZKTLS_DELTA_V1 is that a delta was
 * measured between two proofs the athlete could not tamper with, and a baseline the athlete can edit makes
 * that claim worthless: they would simply lower it until any final passes.
 *
 * It also cannot live on disk. Vercel's filesystem is ephemeral and not shared between invocations, so the
 * file-backed session store from the zkTLS era silently loses state in production.
 *
 * No stake and no escrow are involved here. This is the proof engine with a real user journey around it.
 */

export const DUOLINGO_PREVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS duolingo_preview_sessions (
  session_id text PRIMARY KEY,
  wallet_address text NOT NULL,
  phase text NOT NULL,
  duolingo_username text NOT NULL,
  duolingo_profile_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS duolingo_preview_runs (
  wallet_address text PRIMARY KEY,
  target_xp integer NOT NULL,
  identity_hash text NOT NULL,
  baseline_xp integer NOT NULL,
  baseline_observed_at bigint NOT NULL,
  baseline_session_id text NOT NULL,
  duolingo_profile_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

function sql() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not configured");
  return neon(url);
}

export type PreviewSession = Readonly<{
  sessionId: string;
  walletAddress: string;
  phase: "baseline" | "final";
  duolingoUsername: string;
  duolingoProfileId: string;
}>;

export type PreviewRun = Readonly<{
  walletAddress: string;
  targetXp: number;
  identityHash: Hex;
  baselineXp: number;
  baselineObservedAt: number;
  baselineSessionId: string;
  duolingoProfileId: string;
}>;

export async function savePreviewSession(session: PreviewSession): Promise<void> {
  await sql()`
    INSERT INTO duolingo_preview_sessions
      (session_id, wallet_address, phase, duolingo_username, duolingo_profile_id)
    VALUES (${session.sessionId}, ${session.walletAddress.toLowerCase()}, ${session.phase},
            ${session.duolingoUsername}, ${session.duolingoProfileId})
    ON CONFLICT (session_id) DO NOTHING`;
}

/**
 * The session is the ONLY thing that says which wallet and phase a Reclaim session belongs to. Taking
 * either from the request body would let anyone claim someone else's proof, or replay a baseline as a final.
 */
export async function loadPreviewSession(sessionId: string): Promise<PreviewSession | null> {
  const rows = (await sql()`
    SELECT session_id, wallet_address, phase, duolingo_username, duolingo_profile_id
      FROM duolingo_preview_sessions WHERE session_id = ${sessionId}`
  ) as Record<string, string>[];
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    walletAddress: row.wallet_address,
    phase: row.phase === "final" ? "final" : "baseline",
    duolingoUsername: row.duolingo_username,
    duolingoProfileId: row.duolingo_profile_id,
  };
}

/** A new baseline replaces the old one: starting over is legitimate, and there is no stake to protect. */
export async function savePreviewRun(run: PreviewRun): Promise<void> {
  await sql()`
    INSERT INTO duolingo_preview_runs
      (wallet_address, target_xp, identity_hash, baseline_xp, baseline_observed_at,
       baseline_session_id, duolingo_profile_id)
    VALUES (${run.walletAddress.toLowerCase()}, ${run.targetXp}, ${run.identityHash}, ${run.baselineXp},
            ${run.baselineObservedAt}, ${run.baselineSessionId}, ${run.duolingoProfileId})
    ON CONFLICT (wallet_address) DO UPDATE SET
      target_xp = EXCLUDED.target_xp,
      identity_hash = EXCLUDED.identity_hash,
      baseline_xp = EXCLUDED.baseline_xp,
      baseline_observed_at = EXCLUDED.baseline_observed_at,
      baseline_session_id = EXCLUDED.baseline_session_id,
      duolingo_profile_id = EXCLUDED.duolingo_profile_id,
      created_at = now()`;
}

export async function loadPreviewRun(walletAddress: string): Promise<PreviewRun | null> {
  const rows = (await sql()`
    SELECT wallet_address, target_xp, identity_hash, baseline_xp, baseline_observed_at,
           baseline_session_id, duolingo_profile_id
      FROM duolingo_preview_runs WHERE wallet_address = ${walletAddress.toLowerCase()}`
  ) as Record<string, string | number>[];
  const row = rows[0];
  if (!row) return null;
  return {
    walletAddress: String(row.wallet_address),
    targetXp: Number(row.target_xp),
    identityHash: String(row.identity_hash) as Hex,
    baselineXp: Number(row.baseline_xp),
    baselineObservedAt: Number(row.baseline_observed_at),
    baselineSessionId: String(row.baseline_session_id),
    duolingoProfileId: String(row.duolingo_profile_id),
  };
}

export async function clearPreviewRun(walletAddress: string): Promise<void> {
  await sql()`DELETE FROM duolingo_preview_runs WHERE wallet_address = ${walletAddress.toLowerCase()}`;
}

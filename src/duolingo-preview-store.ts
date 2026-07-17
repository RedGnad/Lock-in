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

export const PREVIEW_SESSION_TTL_SECONDS = 30 * 60;
export const PREVIEW_SESSION_PRUNE_SECONDS = 24 * 60 * 60;

export const DUOLINGO_PREVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS duolingo_preview_sessions (
  session_id text PRIMARY KEY,
  wallet_address text NOT NULL,
  phase text NOT NULL,
  target_xp integer NOT NULL DEFAULT 0,
  duolingo_username text NOT NULL,
  duolingo_profile_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS duolingo_preview_runs (
  wallet_address text PRIMARY KEY,
  target_xp integer NOT NULL,
  identity_hash text NOT NULL,
  baseline_xp integer NOT NULL,
  baseline_observed_at bigint NOT NULL,
  baseline_session_id text NOT NULL,
  duolingo_profile_id text NOT NULL,
  final_xp integer,
  earned_xp integer,
  final_observed_at bigint,
  passed boolean,
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
  targetXp: number;
  duolingoUsername: string;
  duolingoProfileId: string;
}>;

export type PreviewRun = Readonly<{
  walletAddress: string;
  targetXp: number;
  baselineXp: number;
  baselineObservedAt: number;
  duolingoProfileId: string;
  finalXp: number | null;
  earnedXp: number | null;
  finalObservedAt: number | null;
  passed: boolean | null;
}>;

export async function savePreviewSession(session: PreviewSession): Promise<void> {
  await sql()`
    INSERT INTO duolingo_preview_sessions
      (session_id, wallet_address, phase, target_xp, duolingo_username, duolingo_profile_id)
    VALUES (${session.sessionId}, ${session.walletAddress.toLowerCase()}, ${session.phase},
            ${session.targetXp}, ${session.duolingoUsername}, ${session.duolingoProfileId})
    ON CONFLICT (session_id) DO NOTHING`;
}

/**
 * The live session, or null if it does not exist, is already consumed, or has aged out.
 *
 * A Reclaim session is short-lived on purpose: an old session id that leaks should not stay usable, and a
 * baseline captured hours ago should not silently pair with a fresh final. Expiry is enforced in SQL so a
 * clock the client controls can never widen the window. The session is the ONLY source of the wallet,
 * phase and target: taking any of them from the request body would let anyone claim someone else's proof,
 * replay a baseline as a final, or lower the target mid-flight.
 */
export async function loadPreviewSession(sessionId: string): Promise<PreviewSession | null> {
  const rows = (await sql()`
    SELECT session_id, wallet_address, phase, target_xp, duolingo_username, duolingo_profile_id
      FROM duolingo_preview_sessions
      WHERE session_id = ${sessionId}
        AND consumed_at IS NULL
        AND created_at > now() - make_interval(secs => ${PREVIEW_SESSION_TTL_SECONDS})`
  ) as Record<string, string | number>[];
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    walletAddress: String(row.wallet_address),
    phase: row.phase === "final" ? "final" : "baseline",
    targetXp: Number(row.target_xp),
    duolingoUsername: String(row.duolingo_username),
    duolingoProfileId: String(row.duolingo_profile_id),
  };
}

/** Deletes sessions old enough that neither their outcome nor a replay attempt matters any more. */
export async function pruneExpiredSessions(): Promise<void> {
  await sql()`
    DELETE FROM duolingo_preview_sessions
    WHERE created_at < now() - make_interval(secs => ${PREVIEW_SESSION_PRUNE_SECONDS})`;
}

/**
 * Consumes the session and writes the baseline in ONE statement, so the two can never come apart.
 *
 * The failure that this closes: mark consumed, then the baseline write fails, and the athlete is left with
 * a burned session and no baseline. The CTE consumes first and the INSERT reads FROM that CTE, so the
 * insert happens only if the consume did, and both commit together or neither does. A replay finds the
 * session already consumed, the CTE is empty, nothing is written, and the caller sees no row back.
 *
 * A new baseline replaces the old one on purpose: starting over is legitimate, there is no stake.
 */
export async function consumeAndSaveBaseline(input: {
  sessionId: string;
  walletAddress: string;
  targetXp: number;
  identityHash: Hex;
  baselineXp: number;
  baselineObservedAt: number;
  duolingoProfileId: string;
}): Promise<boolean> {
  const rows = (await sql()`
    WITH consumed AS (
      UPDATE duolingo_preview_sessions SET consumed_at = now()
      WHERE session_id = ${input.sessionId} AND consumed_at IS NULL
      RETURNING session_id
    )
    INSERT INTO duolingo_preview_runs
      (wallet_address, target_xp, identity_hash, baseline_xp, baseline_observed_at,
       baseline_session_id, duolingo_profile_id, final_xp, earned_xp, final_observed_at, passed)
    SELECT ${input.walletAddress.toLowerCase()}, ${input.targetXp}, ${input.identityHash},
           ${input.baselineXp}, ${input.baselineObservedAt}, ${input.sessionId}, ${input.duolingoProfileId},
           NULL, NULL, NULL, NULL
    FROM consumed
    ON CONFLICT (wallet_address) DO UPDATE SET
      target_xp = EXCLUDED.target_xp,
      identity_hash = EXCLUDED.identity_hash,
      baseline_xp = EXCLUDED.baseline_xp,
      baseline_observed_at = EXCLUDED.baseline_observed_at,
      baseline_session_id = EXCLUDED.baseline_session_id,
      duolingo_profile_id = EXCLUDED.duolingo_profile_id,
      final_xp = NULL, earned_xp = NULL, final_observed_at = NULL, passed = NULL,
      created_at = now()
    RETURNING wallet_address`
  ) as Record<string, string>[];
  return rows.length === 1;
}

/** Consumes the session and records the final result in one statement, same guarantee as the baseline. */
export async function consumeAndSaveFinal(input: {
  sessionId: string;
  walletAddress: string;
  finalXp: number;
  earnedXp: number;
  finalObservedAt: number;
}): Promise<boolean> {
  const rows = (await sql()`
    WITH consumed AS (
      UPDATE duolingo_preview_sessions SET consumed_at = now()
      WHERE session_id = ${input.sessionId} AND consumed_at IS NULL
      RETURNING session_id
    )
    UPDATE duolingo_preview_runs SET
      final_xp = ${input.finalXp},
      earned_xp = ${input.earnedXp},
      final_observed_at = ${input.finalObservedAt},
      passed = true
    WHERE wallet_address = ${input.walletAddress.toLowerCase()}
      AND EXISTS (SELECT 1 FROM consumed)
    RETURNING wallet_address`
  ) as Record<string, string>[];
  return rows.length === 1;
}

export async function loadPreviewRun(walletAddress: string): Promise<PreviewRun | null> {
  const rows = (await sql()`
    SELECT wallet_address, target_xp, baseline_xp, baseline_observed_at, duolingo_profile_id,
           final_xp, earned_xp, final_observed_at, passed
      FROM duolingo_preview_runs WHERE wallet_address = ${walletAddress.toLowerCase()}`
  ) as Record<string, string | number | boolean | null>[];
  const row = rows[0];
  if (!row) return null;
  return {
    walletAddress: String(row.wallet_address),
    targetXp: Number(row.target_xp),
    baselineXp: Number(row.baseline_xp),
    baselineObservedAt: Number(row.baseline_observed_at),
    duolingoProfileId: String(row.duolingo_profile_id),
    finalXp: row.final_xp === null ? null : Number(row.final_xp),
    earnedXp: row.earned_xp === null ? null : Number(row.earned_xp),
    finalObservedAt: row.final_observed_at === null ? null : Number(row.final_observed_at),
    passed: row.passed === null ? null : Boolean(row.passed),
  };
}

/** The bound identity, kept server-side only. It never leaves this module, and never reaches a response. */
export async function loadPreviewIdentity(walletAddress: string): Promise<Hex | null> {
  const rows = (await sql()`
    SELECT identity_hash FROM duolingo_preview_runs WHERE wallet_address = ${walletAddress.toLowerCase()}`
  ) as Record<string, string>[];
  return rows[0] ? (String(rows[0].identity_hash) as Hex) : null;
}

export async function clearPreviewRun(walletAddress: string): Promise<void> {
  await sql()`DELETE FROM duolingo_preview_runs WHERE wallet_address = ${walletAddress.toLowerCase()}`;
}

export async function previewStorageReachable(): Promise<boolean> {
  try {
    await sql()`SELECT 1 FROM duolingo_preview_sessions LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}

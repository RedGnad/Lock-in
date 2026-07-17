import { neon } from "@neondatabase/serverless";
import type { Hex } from "viem";
import type { EscrowIntent } from "./duolingo-escrow-attestation";

/**
 * Server-side state for the financial Duolingo escrow (contract B, real USDC).
 *
 * These tables are DISTINCT from the Live Proof Beta's (`duolingo_preview_*`) and never touch the Strava
 * production database. The baseline row is the source of truth for the XP delta: the contract stores only
 * the identity binding and the configHash, not the baseline XP, so if this row could be lowered after a
 * stake was placed an athlete could pass any final. It is therefore keyed by (wallet, config_hash) and
 * INSERTed once, never overwritten. The config_hash carries the creator's nonce, so it is unique per Lock.
 */

export const ESCROW_SESSION_TTL_SECONDS = 30 * 60;
export const ESCROW_SESSION_PRUNE_SECONDS = 24 * 60 * 60;

export const DUOLINGO_ESCROW_SCHEMA = `
CREATE TABLE IF NOT EXISTS duolingo_escrow_sessions (
  session_id text PRIMARY KEY,
  wallet_address text NOT NULL,
  intent text NOT NULL,
  phase text NOT NULL,
  pact_id numeric,
  create_nonce text,
  config_hash text,
  target_xp integer NOT NULL DEFAULT 0,
  duolingo_profile_id text NOT NULL,
  context_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS duolingo_escrow_baselines (
  wallet_address text NOT NULL,
  config_hash text NOT NULL,
  intent text NOT NULL,
  pact_id numeric,
  create_nonce text,
  identity_hash text NOT NULL,
  target_xp integer NOT NULL,
  baseline_xp integer NOT NULL,
  baseline_observed_at bigint NOT NULL,
  duolingo_profile_id text NOT NULL,
  baseline_session_id text NOT NULL,
  nullifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, config_hash)
);

CREATE TABLE IF NOT EXISTS duolingo_escrow_finals (
  wallet_address text NOT NULL,
  pact_id numeric NOT NULL,
  identity_hash text NOT NULL,
  earned_xp integer NOT NULL,
  target_xp integer NOT NULL,
  final_xp integer NOT NULL,
  final_observed_at bigint NOT NULL,
  nullifier text NOT NULL,
  final_session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, pact_id)
);
`;

function sql() {
  const url = process.env.DUOLINGO_ESCROW_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DUOLINGO_ESCROW_DATABASE_URL (or DATABASE_URL) is not configured");
  return neon(url);
}

export type EscrowSession = Readonly<{
  sessionId: string;
  walletAddress: string;
  intent: EscrowIntent;
  phase: "baseline" | "final";
  pactId: string | null;
  createNonce: string | null;
  configHash: string | null;
  targetXp: number;
  duolingoProfileId: string;
  contextMessage: string;
}>;

export async function saveEscrowSession(session: EscrowSession): Promise<void> {
  await sql()`
    INSERT INTO duolingo_escrow_sessions
      (session_id, wallet_address, intent, phase, pact_id, create_nonce, config_hash, target_xp,
       duolingo_profile_id, context_message)
    VALUES (${session.sessionId}, ${session.walletAddress.toLowerCase()}, ${session.intent}, ${session.phase},
            ${session.pactId}, ${session.createNonce}, ${session.configHash}, ${session.targetXp},
            ${session.duolingoProfileId}, ${session.contextMessage})
    ON CONFLICT (session_id) DO NOTHING`;
}

/** The live, unconsumed, unexpired session, or null. Every trusted field comes from here, never the body. */
export async function loadEscrowSession(sessionId: string): Promise<EscrowSession | null> {
  const rows = (await sql()`
    SELECT session_id, wallet_address, intent, phase, pact_id, create_nonce, config_hash, target_xp,
           duolingo_profile_id, context_message
      FROM duolingo_escrow_sessions
      WHERE session_id = ${sessionId}
        AND consumed_at IS NULL
        AND created_at > now() - make_interval(secs => ${ESCROW_SESSION_TTL_SECONDS})`
  ) as Record<string, string | number | null>[];
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    walletAddress: String(row.wallet_address),
    intent: (row.intent === "create" || row.intent === "join" ? row.intent : "final") as EscrowIntent,
    phase: row.phase === "final" ? "final" : "baseline",
    pactId: row.pact_id === null ? null : String(row.pact_id),
    createNonce: row.create_nonce === null ? null : String(row.create_nonce),
    configHash: row.config_hash === null ? null : String(row.config_hash),
    targetXp: Number(row.target_xp),
    duolingoProfileId: String(row.duolingo_profile_id),
    contextMessage: String(row.context_message),
  };
}

export async function pruneExpiredEscrowSessions(): Promise<void> {
  await sql()`
    DELETE FROM duolingo_escrow_sessions
    WHERE created_at < now() - make_interval(secs => ${ESCROW_SESSION_PRUNE_SECONDS})`;
}

export type EscrowBaselineRow = Readonly<{
  walletAddress: string;
  configHash: string;
  intent: EscrowIntent;
  pactId: string | null;
  identityHash: string;
  targetXp: number;
  baselineXp: number;
  baselineObservedAt: number;
  duolingoProfileId: string;
  nullifier: string;
}>;

/**
 * Consumes the session and writes the baseline in ONE statement, so a burned session can never leave a
 * missing baseline and a replay finds nothing to write. The baseline is INSERTed once per (wallet,
 * config_hash): ON CONFLICT DO NOTHING, because overwriting a baseline that a stake is already bound to
 * would let an athlete lower their starting XP and pass any final. Returns true only if this call is the
 * one that recorded it.
 */
export async function consumeAndSaveBaseline(input: {
  sessionId: string;
  walletAddress: string;
  configHash: string;
  intent: EscrowIntent;
  pactId: string | null;
  createNonce: string | null;
  identityHash: Hex;
  targetXp: number;
  baselineXp: number;
  baselineObservedAt: number;
  duolingoProfileId: string;
  nullifier: Hex;
}): Promise<boolean> {
  const rows = (await sql()`
    WITH consumed AS (
      UPDATE duolingo_escrow_sessions SET consumed_at = now()
      WHERE session_id = ${input.sessionId} AND consumed_at IS NULL
      RETURNING session_id
    )
    INSERT INTO duolingo_escrow_baselines
      (wallet_address, config_hash, intent, pact_id, create_nonce, identity_hash, target_xp, baseline_xp,
       baseline_observed_at, duolingo_profile_id, baseline_session_id, nullifier)
    SELECT ${input.walletAddress.toLowerCase()}, ${input.configHash}, ${input.intent}, ${input.pactId},
           ${input.createNonce}, ${input.identityHash}, ${input.targetXp}, ${input.baselineXp},
           ${input.baselineObservedAt}, ${input.duolingoProfileId}, ${input.sessionId}, ${input.nullifier}
    FROM consumed
    ON CONFLICT (wallet_address, config_hash) DO NOTHING
    RETURNING wallet_address`
  ) as Record<string, string>[];
  return rows.length === 1;
}

export async function loadEscrowBaseline(
  walletAddress: string,
  configHash: string,
): Promise<EscrowBaselineRow | null> {
  const rows = (await sql()`
    SELECT wallet_address, config_hash, intent, pact_id, identity_hash, target_xp, baseline_xp,
           baseline_observed_at, duolingo_profile_id, nullifier
      FROM duolingo_escrow_baselines
      WHERE wallet_address = ${walletAddress.toLowerCase()} AND config_hash = ${configHash}`
  ) as Record<string, string | number | null>[];
  const row = rows[0];
  if (!row) return null;
  return {
    walletAddress: String(row.wallet_address),
    configHash: String(row.config_hash),
    intent: (row.intent === "create" || row.intent === "join" ? row.intent : "final") as EscrowIntent,
    pactId: row.pact_id === null ? null : String(row.pact_id),
    identityHash: String(row.identity_hash),
    targetXp: Number(row.target_xp),
    baselineXp: Number(row.baseline_xp),
    baselineObservedAt: Number(row.baseline_observed_at),
    duolingoProfileId: String(row.duolingo_profile_id),
    nullifier: String(row.nullifier),
  };
}

/**
 * Consumes the session and records the passing final in one statement. Idempotent on (wallet, pact_id): a
 * later, better final for the same Lock updates the row rather than duplicating it. The final nullifier is
 * deterministic from (identity, pactId), so re-issuing an attestation after a dropped transaction is safe.
 * The caller signs the attestation regardless of whether this recorded a new row.
 */
export async function consumeAndSaveFinal(input: {
  sessionId: string;
  walletAddress: string;
  pactId: string;
  identityHash: Hex;
  earnedXp: number;
  targetXp: number;
  finalXp: number;
  finalObservedAt: number;
  nullifier: Hex;
}): Promise<boolean> {
  const rows = (await sql()`
    WITH consumed AS (
      UPDATE duolingo_escrow_sessions SET consumed_at = now()
      WHERE session_id = ${input.sessionId} AND consumed_at IS NULL
      RETURNING session_id
    )
    INSERT INTO duolingo_escrow_finals
      (wallet_address, pact_id, identity_hash, earned_xp, target_xp, final_xp, final_observed_at,
       nullifier, final_session_id)
    SELECT ${input.walletAddress.toLowerCase()}, ${input.pactId}, ${input.identityHash}, ${input.earnedXp},
           ${input.targetXp}, ${input.finalXp}, ${input.finalObservedAt}, ${input.nullifier}, ${input.sessionId}
    FROM consumed
    ON CONFLICT (wallet_address, pact_id) DO UPDATE SET
      earned_xp = EXCLUDED.earned_xp,
      final_xp = EXCLUDED.final_xp,
      final_observed_at = EXCLUDED.final_observed_at,
      nullifier = EXCLUDED.nullifier,
      final_session_id = EXCLUDED.final_session_id,
      updated_at = now()
    RETURNING wallet_address`
  ) as Record<string, string>[];
  return rows.length === 1;
}

export async function escrowStorageReachable(): Promise<boolean> {
  try {
    await sql()`SELECT 1 FROM duolingo_escrow_sessions LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}

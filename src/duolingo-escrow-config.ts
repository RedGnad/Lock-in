/**
 * The create-Lock terms, validated against LockInDuolingoEscrow's own bounds BEFORE the backend signs a
 * baseline for them. The contract re-checks everything in `_validateConfiguration`, so this is not the
 * security boundary; it just refuses to spend a Reclaim proof on a configuration createPact would reject.
 */

export const ESCROW_LIMITS = {
  minStake: 100_000n, // 0.1 USDC (6 decimals)
  maxStake: 1_000_000n, // 1 USDC
  minTargetXp: 10,
  maxTargetXp: 1_000_000,
  minDurationSeconds: 30 * 60,
  maxDurationSeconds: 30 * 24 * 60 * 60,
  minParticipants: 2,
  maxParticipants: 100,
  maxStartDelaySeconds: 24 * 60 * 60,
} as const;

export const DUOLINGO_REGISTRATION_SECONDS = 23 * 60 * 60;

export function scheduledDuolingoStart(chainTimestamp: bigint): bigint {
  const fiveMinutes = 5n * 60n;
  const earliest = chainTimestamp + BigInt(DUOLINGO_REGISTRATION_SECONDS);
  return ((earliest + fiveMinutes - 1n) / fiveMinutes) * fiveMinutes;
}

export type EscrowCreateTerms = Readonly<{
  stake: bigint;
  targetXp: number;
  durationSeconds: number;
  minParticipants: number;
  maxParticipants: number;
  startsAt: bigint;
}>;

export class EscrowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowConfigError";
  }
}

function integer(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new EscrowConfigError(`${label} must be a whole number`);
  return n;
}

/**
 * Parses and bounds-checks the raw create terms. `startsAt` is validated against `nowSeconds`: it must be
 * in the future and no more than the contract's MAX_START_DELAY ahead, so a same-day canary works while a
 * far-future start is refused.
 */
export function parseEscrowCreateTerms(
  raw: Record<string, unknown>,
  nowSeconds = Math.floor(Date.now() / 1_000),
): EscrowCreateTerms {
  let stake: bigint;
  try {
    stake = BigInt(String(raw.stake));
  } catch {
    throw new EscrowConfigError("Choose a stake");
  }
  if (stake < ESCROW_LIMITS.minStake || stake > ESCROW_LIMITS.maxStake) {
    throw new EscrowConfigError("The stake is outside the allowed range");
  }
  const targetXp = integer(raw.targetXp, "The XP target");
  if (targetXp < ESCROW_LIMITS.minTargetXp || targetXp > ESCROW_LIMITS.maxTargetXp) {
    throw new EscrowConfigError("The XP target is outside the allowed range");
  }
  const durationSeconds = integer(raw.durationSeconds, "The duration");
  if (durationSeconds < ESCROW_LIMITS.minDurationSeconds || durationSeconds > ESCROW_LIMITS.maxDurationSeconds) {
    throw new EscrowConfigError("The duration is outside the allowed range");
  }
  const minParticipants = integer(raw.minParticipants, "The minimum participants");
  const maxParticipants = integer(raw.maxParticipants, "The maximum participants");
  if (
    minParticipants < ESCROW_LIMITS.minParticipants
      || minParticipants > maxParticipants
      || maxParticipants > ESCROW_LIMITS.maxParticipants
  ) {
    throw new EscrowConfigError("The participant range is invalid");
  }
  const startsAtNumber = integer(raw.startsAt, "The start time");
  if (startsAtNumber <= nowSeconds || startsAtNumber > nowSeconds + ESCROW_LIMITS.maxStartDelaySeconds) {
    throw new EscrowConfigError("The start time must be within the next 24 hours");
  }
  return {
    stake,
    targetXp,
    durationSeconds,
    minParticipants,
    maxParticipants,
    startsAt: BigInt(startsAtNumber),
  };
}

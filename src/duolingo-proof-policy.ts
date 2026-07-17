import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Hex,
} from "viem";
import type { ReclaimTrustedData } from "./strava-proof-policy";

export const DUOLINGO_PROVIDER_VERSION = "1.0.8";
export const DUOLINGO_PROVIDER_ID = "cdf8cb3b-2976-4413-ab2d-693ae5028380";
export const DUOLINGO_OWNERSHIP_REQUEST_HASH = "0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e";
export const DUOLINGO_XP_REQUEST_HASH = "0x92d80894f1f9e2f3574b840e846e41a49ae7491b587da9bd96cbcccbe001c8ed";

/**
 * DUOLINGO_ZKTLS_DELTA_V1: two proofs per Lock, baseline then final.
 *
 * This mission is CUMULATIVE, not daily. It says "earn 300 new XP before the deadline", and it must never
 * be described as a streak or as daily practice: a delta between two points proves the total moved, and
 * nothing at all about when. Strava's per-day check-ins are the mission that proves regularity; this one
 * is deliberately a different promise.
 */
export type DuolingoPhase = "baseline" | "final";

export type DuolingoPolicy = {
  walletAddress: string;
  pactId: string;
  phase: DuolingoPhase;
  expectedSessionId: string;
  expectedProfileId: string;
  /**
   * The exact signed `contextMessage` the proof must carry. The Preview leaves this unset and the default
   * `${pactId}:${phase}` applies. The financial escrow flow sets it explicitly, because a create baseline
   * is bound to a server createNonce rather than a pactId that does not exist yet.
   */
  expectedContextMessage?: string;
};

export type DuolingoEvidence = {
  profileId: string;
  totalXp: number;
  identityHash: Hex;
  eventNullifier: Hex;
  observedAt: number;
  sessionId: string;
  phase: DuolingoPhase;
};

export class DuolingoPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DuolingoPolicyError";
  }
}

function reject(code: string, message: string): never {
  throw new DuolingoPolicyError(code, message);
}

export function duolingoProviderId(): string {
  const value = process.env.DUOLINGO_PROVIDER_ID?.trim();
  if (value && value !== DUOLINGO_PROVIDER_ID) throw new Error("DUOLINGO_PROVIDER_ID does not match the pinned provider");
  return DUOLINGO_PROVIDER_ID;
}

function contextString(context: Record<string, unknown>, key: string): string {
  const value = context[key];
  if (typeof value !== "string" || value.length === 0) {
    return reject("INVALID_CONTEXT", `Missing signed context field ${key}`);
  }
  return value;
}

function fieldValues(data: readonly ReclaimTrustedData[], key: string): string[] {
  return data.flatMap((item) => {
    const value = item.extractedParameters[key];
    return typeof value === "string" ? [value] : [];
  });
}

function oneField(data: readonly ReclaimTrustedData[], key: string): string {
  const values = fieldValues(data, key);
  if (values.length === 0) reject("MISSING_FIELD", `Missing signed Duolingo field ${key}`);
  if (new Set(values).size !== 1) reject("CONFLICTING_FIELD", `Conflicting signed values for ${key}`);
  return values[0];
}

function proofIndexWithField(data: readonly ReclaimTrustedData[], key: string): number {
  const indexes = data.flatMap((item, index) => typeof item.extractedParameters[key] === "string" ? [index] : []);
  if (indexes.length !== 1) reject("INVALID_PROOF_ROLE", `Expected exactly one Duolingo ${key} proof`);
  return indexes[0];
}

export function validateDuolingoEvidence(input: {
  data: readonly ReclaimTrustedData[];
  timestamps: readonly number[];
  providerId: string;
  policy: DuolingoPolicy;
}): DuolingoEvidence {
  const { data, timestamps, providerId, policy } = input;
  if (providerId !== DUOLINGO_PROVIDER_ID) {
    reject("WRONG_PROVIDER", "The proof does not use the pinned Duolingo provider");
  }
  if (data.length !== 2) reject("WRONG_PROOF_COUNT", "The Duolingo provider must return ownership and XP proofs");
  if (timestamps.length !== 2 || timestamps.some((value) => !Number.isSafeInteger(value))) {
    reject("INVALID_PROOF_TIME", "The Duolingo proof timestamps are invalid");
  }
  if (!isAddress(policy.walletAddress) || !/^\d+$/.test(policy.pactId)) {
    reject("INVALID_POLICY", "The expected wallet or lock is invalid");
  }
  if (!/^[1-9]\d{0,19}$/.test(policy.expectedProfileId)) {
    reject("INVALID_POLICY", "The expected Duolingo profile id is invalid");
  }

  const expectedAddress = getAddress(policy.walletAddress).toLowerCase();
  // The phase is inside the SIGNED context, so a baseline can never be replayed as a final, nor a proof
  // from one Lock be presented to another. The escrow flow overrides the message with a create-nonce or
  // pact-scoped binding; the Preview uses the default pactId:phase.
  const expectedMessage = policy.expectedContextMessage ?? `${policy.pactId}:${policy.phase}`;
  const providerHashes = new Set<string>();
  for (const item of data) {
    if (contextString(item.context, "contextAddress").toLowerCase() !== expectedAddress) {
      reject("WRONG_WALLET", "The proof is bound to another wallet");
    }
    if (contextString(item.context, "contextMessage") !== expectedMessage) {
      reject("WRONG_PACT_PHASE", "The proof is bound to another lock or phase");
    }
    if (contextString(item.context, "reclaimSessionId") !== policy.expectedSessionId) {
      reject("WRONG_SESSION", "The proof does not belong to this Reclaim session");
    }
    providerHashes.add(contextString(item.context, "providerHash").toLowerCase());
  }
  if (
    providerHashes.size !== 2
      || !providerHashes.has(DUOLINGO_OWNERSHIP_REQUEST_HASH)
      || !providerHashes.has(DUOLINGO_XP_REQUEST_HASH)
  ) reject("WRONG_REQUEST_SCHEMA", "The proof does not contain both pinned Duolingo requests");

  const ownershipIndex = proofIndexWithField(data, "marker");
  const profileIndex = proofIndexWithField(data, "xp");
  if (ownershipIndex === profileIndex) reject("INVALID_PROOF_ROLE", "Duolingo ownership and XP must be separate proofs");
  if (oneField(data, "marker") !== "disable_social") {
    reject("ACCOUNT_NOT_OWNED", "The Duolingo session does not control this profile");
  }

  const profileId = oneField(data, "id");
  const totalXpRaw = oneField(data, "xp");
  if (profileId !== policy.expectedProfileId) {
    reject("ACCOUNT_NOT_OWNED", "The authenticated Duolingo account does not match the requested profile");
  }
  if (!/^[1-9]\d{0,19}$/.test(profileId) || BigInt(profileId) > (1n << 64n) - 1n) {
    reject("INVALID_PROFILE", "The Duolingo profile id is invalid");
  }
  if (!/^(?:0|[1-9]\d{0,9})$/.test(totalXpRaw)) reject("INVALID_XP", "The signed Duolingo XP is invalid");
  const totalXp = Number(totalXpRaw);
  if (!Number.isSafeInteger(totalXp) || totalXp > 2_000_000_000) {
    reject("INVALID_XP", "The signed Duolingo XP is outside the accepted range");
  }

  const providerKey = keccak256(stringToHex(`${providerId}@${DUOLINGO_PROVIDER_VERSION}`));
  const identityHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 providerKey, uint256 profileId"),
    [providerKey, BigInt(profileId)],
  ));
  // Bound to the Lock AND the phase, never to the XP value. Keying on totalXp would collide across Locks
  // that share a baseline, and would let one wallet submit two different baselines for the same Lock. One
  // identity gets exactly one baseline and one final per Lock, and the escrow's global nullifier set
  // enforces it.
  const eventNullifier = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 identityHash, uint256 pactId, bytes32 phase"),
    [identityHash, BigInt(policy.pactId), keccak256(stringToHex(policy.phase))],
  ));

  return {
    profileId,
    totalXp,
    identityHash,
    eventNullifier,
    observedAt: timestamps[profileIndex],
    sessionId: policy.expectedSessionId,
    phase: policy.phase,
  };
}

export type DuolingoDelta = Readonly<{
  identityHash: Hex;
  baselineXp: number;
  finalXp: number;
  earnedXp: number;
  baselineNullifier: Hex;
  finalNullifier: Hex;
}>;

/**
 * The whole of DUOLINGO_ZKTLS_DELTA_V1's verdict: did this athlete earn the target between two proofs
 * they cannot have forged, swapped or reordered?
 *
 * Each input has already passed validateDuolingoEvidence, so each is TEE-verified, wallet-bound and
 * Lock-bound. What is left is everything that only exists in the RELATION between them.
 */
export function validateDuolingoDelta(input: {
  baseline: DuolingoEvidence;
  final: DuolingoEvidence;
  targetXp: number;
  maxFinalAgeSeconds?: number;
  now?: number;
}): DuolingoDelta {
  const { baseline, final, targetXp } = input;

  if (baseline.phase !== "baseline" || final.phase !== "final") {
    reject("WRONG_PHASE_ORDER", "A delta needs one baseline and one final, in that order");
  }
  // Swapping the account between the two proofs would let an athlete borrow someone else's progress.
  if (baseline.identityHash !== final.identityHash) {
    reject("IDENTITY_CHANGED", "The final proof is a different Duolingo account than the baseline");
  }
  if (baseline.eventNullifier === final.eventNullifier) {
    reject("REPLAYED_PROOF", "The final proof reuses the baseline's nullifier");
  }
  // Strictly later: equal timestamps would make a single capture serve as both ends of its own delta.
  if (!(final.observedAt > baseline.observedAt)) {
    reject("FINAL_NOT_AFTER_BASELINE", "The final proof is not strictly newer than the baseline");
  }
  if (!Number.isSafeInteger(targetXp) || targetXp <= 0) {
    reject("INVALID_TARGET", "The XP target is invalid");
  }
  // XP only ever grows on Duolingo. A drop means we are not comparing what we think we are.
  if (final.totalXp < baseline.totalXp) {
    reject("XP_WENT_BACKWARDS", "The final XP is below the baseline");
  }

  const maxAge = input.maxFinalAgeSeconds;
  if (maxAge !== undefined) {
    const now = input.now ?? Math.floor(Date.now() / 1_000);
    if (final.observedAt > now + 60) reject("FINAL_IN_FUTURE", "The final proof is dated in the future");
    if (now - final.observedAt > maxAge) reject("FINAL_TOO_OLD", "The final proof is outside the submission window");
  }

  const earnedXp = final.totalXp - baseline.totalXp;
  if (earnedXp < targetXp) {
    reject("TARGET_NOT_MET", `Earned ${earnedXp} XP of the ${targetXp} this Lock requires`);
  }

  return {
    identityHash: baseline.identityHash,
    baselineXp: baseline.totalXp,
    finalXp: final.totalXp,
    earnedXp,
    baselineNullifier: baseline.eventNullifier,
    finalNullifier: final.eventNullifier,
  };
}

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

export type DuolingoPolicy = {
  walletAddress: string;
  pactId: string;
  phase: "baseline" | "completion";
  dayIndex?: number;
  expectedSessionId: string;
  expectedProfileId: string;
};

export type DuolingoEvidence = {
  profileId: string;
  totalXp: number;
  identityHash: Hex;
  eventNullifier: Hex;
  observedAt: number;
  sessionId: string;
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
  const expectedMessage = policy.phase === "baseline"
    ? `${policy.pactId}:baseline`
    : `${policy.pactId}:${policy.dayIndex}`;
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
  const eventNullifier = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 identityHash, uint64 totalXp"),
    [identityHash, BigInt(totalXp)],
  ));

  return {
    profileId,
    totalXp,
    identityHash,
    eventNullifier,
    observedAt: timestamps[profileIndex],
    sessionId: policy.expectedSessionId,
  };
}

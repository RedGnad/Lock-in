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

export const DUOLINGO_PROVIDER_VERSION = "1.0.0";
export const DUOLINGO_PROVIDER_ID = "cdf8cb3b-2976-4413-ab2d-693ae5028380";
export const DUOLINGO_PROVIDER_HASH = "0xeee21aafba194b3d8e48a5a538d8920c69aac0924ab04c63a408571f8291f61a";

export type DuolingoPolicy = {
  walletAddress: string;
  pactId: string;
  phase: "baseline" | "completion";
  dayIndex?: number;
  expectedSessionId: string;
  expectedOwnershipCode: string;
};

export type DuolingoEvidence = {
  profileId: string;
  username: string;
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

export function duolingoOwnershipCode(walletAddress: string): string {
  if (!isAddress(walletAddress)) throw new Error("Invalid wallet address");
  const digest = keccak256(encodeAbiParameters(
    parseAbiParameters("string namespace, uint256 chainId, address account"),
    ["LOCK_IN_DUOLINGO", 143n, getAddress(walletAddress)],
  ));
  return `LI-${digest.slice(2, 34).toUpperCase()}`;
}

function contextString(context: Record<string, unknown>, key: string): string {
  const value = context[key];
  if (typeof value !== "string" || value.length === 0) {
    return reject("INVALID_CONTEXT", `Missing signed context field ${key}`);
  }
  return value;
}

function oneField(data: readonly ReclaimTrustedData[], key: string): string {
  const values = data.flatMap((item) => {
    const value = item.extractedParameters[key];
    return typeof value === "string" ? [value] : [];
  });
  if (values.length === 0) reject("MISSING_FIELD", `Missing signed Duolingo field ${key}`);
  if (new Set(values).size !== 1) reject("CONFLICTING_FIELD", `Conflicting signed values for ${key}`);
  return values[0];
}

export function validateDuolingoEvidence(input: {
  data: readonly ReclaimTrustedData[];
  timestamps: readonly number[];
  providerId: string;
  policy: DuolingoPolicy;
}): DuolingoEvidence {
  const { data, timestamps, providerId, policy } = input;
  if (data.length !== 1) reject("WRONG_PROOF_COUNT", "The Duolingo provider must return one proof");
  if (timestamps.length !== 1 || !Number.isSafeInteger(timestamps[0])) {
    reject("INVALID_PROOF_TIME", "The Duolingo proof timestamp is invalid");
  }
  if (!isAddress(policy.walletAddress) || !/^\d+$/.test(policy.pactId)) {
    reject("INVALID_POLICY", "The expected wallet or pact is invalid");
  }
  if (!/^LI-[0-9A-F]{32}$/.test(policy.expectedOwnershipCode)) {
    reject("INVALID_POLICY", "The ownership code is invalid");
  }

  const expectedAddress = getAddress(policy.walletAddress).toLowerCase();
  const expectedMessage = policy.phase === "baseline"
    ? `${policy.pactId}:baseline`
    : `${policy.pactId}:${policy.dayIndex}`;
  for (const item of data) {
    if (contextString(item.context, "contextAddress").toLowerCase() !== expectedAddress) {
      reject("WRONG_WALLET", "The proof is bound to another wallet");
    }
    if (contextString(item.context, "contextMessage") !== expectedMessage) {
      reject("WRONG_PACT_PHASE", "The proof is bound to another pact or phase");
    }
    if (contextString(item.context, "reclaimSessionId") !== policy.expectedSessionId) {
      reject("WRONG_SESSION", "The proof does not belong to this Reclaim session");
    }
  }

  const profileId = oneField(data, "id");
  const username = oneField(data, "username");
  const bio = oneField(data, "bio").trim();
  const totalXpRaw = oneField(data, "totalXp");
  if (!/^\d{1,20}$/.test(profileId)) reject("INVALID_PROFILE", "The Duolingo profile id is invalid");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) reject("INVALID_USERNAME", "The Duolingo username is invalid");
  if (bio !== policy.expectedOwnershipCode) {
    reject("ACCOUNT_NOT_OWNED", `Set the Duolingo bio to exactly ${policy.expectedOwnershipCode}`);
  }
  if (!/^\d{1,10}$/.test(totalXpRaw)) reject("INVALID_XP", "The signed Duolingo XP is invalid");
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
    username,
    totalXp,
    identityHash,
    eventNullifier,
    observedAt: timestamps[0],
    sessionId: policy.expectedSessionId,
  };
}

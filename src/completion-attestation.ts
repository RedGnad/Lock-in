import { concat, getAddress, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const completionTypes = {
  Completion: [
    { name: "pactId", type: "uint256" },
    { name: "account", type: "address" },
    { name: "dayIndex", type: "uint8" },
    { name: "missionType", type: "uint8" },
    { name: "policyHash", type: "bytes32" },
    { name: "sessionIdHash", type: "bytes32" },
    { name: "identityHash", type: "bytes32" },
    { name: "eventNullifier", type: "bytes32" },
    { name: "metric", type: "uint64" },
    { name: "proofSetHash", type: "bytes32" },
    { name: "occurredAt", type: "uint64" },
    { name: "oldestProofTimestamp", type: "uint32" },
    { name: "newestProofTimestamp", type: "uint32" },
    { name: "movingTimeSeconds", type: "uint64" },
    { name: "elapsedTimeSeconds", type: "uint64" },
    { name: "elevationGainMeters", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export type CompletionAttestation = {
  pactId: bigint;
  account: Address;
  dayIndex: number;
  missionType: number;
  policyHash: Hex;
  sessionIdHash: Hex;
  identityHash: Hex;
  eventNullifier: Hex;
  metric: bigint;
  proofSetHash: Hex;
  occurredAt: bigint;
  oldestProofTimestamp: number;
  newestProofTimestamp: number;
  movingTimeSeconds: bigint;
  elapsedTimeSeconds: bigint;
  elevationGainMeters: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
};

/** Caps how long a signed attestation stays usable, from both the observation and the signer window. */
export function attestationExpiry(issuedAt: bigint, observedAtSeconds: readonly number[]): bigint {
  if (observedAtSeconds.length === 0 || observedAtSeconds.some((value) => !Number.isSafeInteger(value))) {
    throw new Error("At least one valid observation timestamp is required");
  }
  const observationFreshUntil = BigInt(Math.min(...observedAtSeconds)) + 10n * 60n;
  const signerWindowEnd = issuedAt + 5n * 60n;
  const expiresAt = signerWindowEnd < observationFreshUntil ? signerWindowEnd : observationFreshUntil;
  if (expiresAt <= issuedAt) throw new Error("The observation expired before it could be attested");
  return expiresAt;
}

function domain(chainId: number, verifyingContract: Address) {
  return {
    name: "Lock In",
    version: "1",
    chainId,
    verifyingContract: getAddress(verifyingContract),
  } as const;
}

export async function signCompletion(input: {
  privateKey: Hex;
  chainId: number;
  verifyingContract: Address;
  completion: CompletionAttestation;
}): Promise<Hex> {
  return privateKeyToAccount(input.privateKey).signTypedData({
    domain: domain(input.chainId, input.verifyingContract),
    types: completionTypes,
    primaryType: "Completion",
    message: input.completion,
  });
}

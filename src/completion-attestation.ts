import { concat, getAddress, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Proof } from "@reclaimprotocol/js-sdk";

export const baselineTypes = {
  Baseline: [
    { name: "pactId", type: "uint256" },
    { name: "account", type: "address" },
    { name: "identityHash", type: "bytes32" },
    { name: "totalMetric", type: "uint64" },
    { name: "proofHash", type: "bytes32" },
    { name: "observedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const completionTypes = {
  Completion: [
    { name: "pactId", type: "uint256" },
    { name: "account", type: "address" },
    { name: "dayIndex", type: "uint8" },
    { name: "missionType", type: "uint8" },
    { name: "identityHash", type: "bytes32" },
    { name: "eventNullifier", type: "bytes32" },
    { name: "metric", type: "uint64" },
    { name: "proofHash", type: "bytes32" },
    { name: "occurredAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export type BaselineAttestation = {
  pactId: bigint;
  account: Address;
  identityHash: Hex;
  totalMetric: bigint;
  proofHash: Hex;
  observedAt: bigint;
  expiresAt: bigint;
};

export type CompletionAttestation = {
  pactId: bigint;
  account: Address;
  dayIndex: number;
  missionType: number;
  identityHash: Hex;
  eventNullifier: Hex;
  metric: bigint;
  proofHash: Hex;
  occurredAt: bigint;
  expiresAt: bigint;
};

export function proofSetHash(proofs: readonly Proof[]): Hex {
  if (proofs.length === 0) throw new Error("At least one proof is required");
  const identifiers = proofs.map((proof) => proof.claimData.identifier as Hex);
  return keccak256(concat(identifiers));
}

function domain(chainId: number, verifyingContract: Address) {
  return {
    name: "Lock In",
    version: "5",
    chainId,
    verifyingContract: getAddress(verifyingContract),
  } as const;
}

export async function signBaseline(input: {
  privateKey: Hex;
  chainId: number;
  verifyingContract: Address;
  baseline: BaselineAttestation;
}): Promise<Hex> {
  return privateKeyToAccount(input.privateKey).signTypedData({
    domain: domain(input.chainId, input.verifyingContract),
    types: baselineTypes,
    primaryType: "Baseline",
    message: input.baseline,
  });
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

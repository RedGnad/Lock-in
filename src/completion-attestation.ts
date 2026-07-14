import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Proof } from "@reclaimprotocol/js-sdk";

export const completionTypes = {
  Completion: [
    { name: "pactId", type: "uint256" },
    { name: "account", type: "address" },
    { name: "dayIndex", type: "uint8" },
    { name: "activityNullifier", type: "bytes32" },
    { name: "proofSetHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export type CompletionAttestation = {
  pactId: bigint;
  account: Address;
  dayIndex: number;
  activityNullifier: Hex;
  proofSetHash: Hex;
  expiresAt: bigint;
};

export function proofSetHash(proofs: readonly Proof[]): Hex {
  if (proofs.length !== 4) throw new Error("Exactly four proofs are required");
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 identity, bytes32 core, bytes32 gps, bytes32 trainer"),
    proofs.map((proof) => proof.claimData.identifier as Hex) as [Hex, Hex, Hex, Hex],
  ));
}

export async function signCompletion(input: {
  privateKey: Hex;
  chainId: number;
  verifyingContract: Address;
  completion: CompletionAttestation;
}): Promise<Hex> {
  return privateKeyToAccount(input.privateKey).signTypedData({
    domain: {
      name: "Lock In",
      version: "3",
      chainId: input.chainId,
      verifyingContract: getAddress(input.verifyingContract),
    },
    types: completionTypes,
    primaryType: "Completion",
    message: input.completion,
  });
}

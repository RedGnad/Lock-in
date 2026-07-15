import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ACCESS_CREATE = 1;
export const ACCESS_JOIN = 2;
export const ACCESS_TTL_SECONDS = 5 * 60;

export const accessTypes = {
  Access: [
    { name: "account", type: "address" },
    { name: "action", type: "uint8" },
    { name: "pactId", type: "uint256" },
    { name: "configHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export type AccessAttestation = {
  account: Address;
  action: number;
  pactId: bigint;
  configHash: Hex;
  nonce: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
};

export type AccessEvidence = readonly [
  configHash: Hex,
  nonce: Hex,
  issuedAt: bigint,
  expiresAt: bigint,
  signature: Hex,
];

export function accessDomain(chainId: number, verifyingContract: Address) {
  return {
    name: "Lock In",
    version: "1",
    chainId,
    verifyingContract: getAddress(verifyingContract),
  } as const;
}

export async function signAccess(input: {
  privateKey: Hex;
  chainId: number;
  verifyingContract: Address;
  access: AccessAttestation;
}): Promise<Hex> {
  return privateKeyToAccount(input.privateKey).signTypedData({
    domain: accessDomain(input.chainId, input.verifyingContract),
    types: accessTypes,
    primaryType: "Access",
    message: input.access,
  });
}

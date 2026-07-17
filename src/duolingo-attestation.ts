import { createHmac } from "node:crypto";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The EIP-712 attestations the Duolingo escrow (contract B) accepts.
 *
 * Every value here is computed to match contracts/LockInDuolingoEscrow.sol byte for byte, and pinned by a
 * cross-language test. The Strava config-hash bug came from each side validating its own formula; the
 * pin is what stops that from recurring.
 */

export const DUOLINGO_XP_SCHEME = keccak256(stringToHex("DUOLINGO_ZKTLS_DELTA_V1"));
const POLICY_TYPEHASH = keccak256(stringToHex("MissionPolicy(uint256 chainId,bytes32 scheme)"));
export const CHAIN_ID = 143n;

export const DUOLINGO_DOMAIN = {
  name: "Lock In Duolingo",
  version: "1",
  chainId: Number(CHAIN_ID),
} as const;

export const BASELINE_TYPES = {
  Baseline: [
    { name: "account", type: "address" },
    { name: "configHash", type: "bytes32" },
    { name: "identityHash", type: "bytes32" },
    { name: "nullifier", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const FINAL_TYPES = {
  Final: [
    { name: "pactId", type: "uint256" },
    { name: "account", type: "address" },
    { name: "identityHash", type: "bytes32" },
    { name: "earnedXp", type: "uint32" },
    { name: "targetXp", type: "uint32" },
    { name: "nullifier", type: "bytes32" },
    { name: "occurredAt", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** The escrow's `_missionPolicyHash()`: keccak256(abi.encode(POLICY_TYPEHASH, chainid, scheme)). */
export function missionPolicyHash(): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, uint256, bytes32"),
    [POLICY_TYPEHASH, CHAIN_ID, DUOLINGO_XP_SCHEME],
  ));
}

export type DuolingoConfig = Readonly<{
  stake: bigint;
  targetXp: number;
  durationSeconds: number;
  minParticipants: number;
  maxParticipants: number;
  startsAt: bigint;
}>;

/** The escrow's `_hashConfiguration(...)`, the value a baseline is bound to. */
export function hashDuolingoConfiguration(config: DuolingoConfig): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("uint96, uint32, uint32, uint8, uint8, uint64, bytes32"),
    [
      config.stake,
      config.targetXp,
      config.durationSeconds,
      config.minParticipants,
      config.maxParticipants,
      config.startsAt,
      missionPolicyHash(),
    ],
  ));
}

/**
 * The pseudonymous identity: HMAC of the Duolingo profile id under a server-held key. Never the raw id, and
 * never a bare keccak of an enumerable id. Its own key, never a Strava key.
 */
export function duolingoIdentityHash(profileId: string): Hex {
  const key = process.env.DUOLINGO_IDENTITY_HMAC_KEY?.trim();
  if (!key) throw new Error("DUOLINGO_IDENTITY_HMAC_KEY is not configured");
  const digest = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`DUOLINGO_ZKTLS_DELTA_V1:athlete:${profileId}`)
    .digest("hex");
  return `0x${digest}`;
}

function evidenceSignerKey(): Hex {
  const key = process.env.DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY?.trim();
  if (!key) throw new Error("DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY is not configured");
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

export type BaselineMessage = {
  account: Hex;
  configHash: Hex;
  identityHash: Hex;
  nullifier: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
};

export type FinalMessage = {
  pactId: bigint;
  account: Hex;
  identityHash: Hex;
  earnedXp: number;
  targetXp: number;
  nullifier: Hex;
  occurredAt: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
};

export async function signBaseline(message: BaselineMessage, verifyingContract: Hex): Promise<Hex> {
  return privateKeyToAccount(evidenceSignerKey()).signTypedData({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract },
    types: BASELINE_TYPES,
    primaryType: "Baseline",
    message,
  });
}

export async function signFinal(message: FinalMessage, verifyingContract: Hex): Promise<Hex> {
  return privateKeyToAccount(evidenceSignerKey()).signTypedData({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract },
    types: FINAL_TYPES,
    primaryType: "Final",
    message,
  });
}

export function duolingoEvidenceSignerAddress(): Hex {
  return privateKeyToAccount(evidenceSignerKey()).address;
}

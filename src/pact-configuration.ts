import { encodeAbiParameters, keccak256, stringToHex, type Hash } from "viem";

/**
 * The Lock configuration hash, derived EXACTLY as the escrow derives it.
 *
 * The escrow binds every admission attestation to this hash, so if the two derivations disagree by one
 * byte, createPact is rejected and no Lock can ever be created. Read alongside `_hashPactConfiguration`
 * and `_missionPolicyHash` in contracts/LockInEscrow.sol; the test pins the result against the value the
 * deployed escrow actually returns, which is the only thing that makes this safe to change.
 */

/** Mirrors the deployed escrow's constants byte for byte. */
const POLICY_TYPEHASH = keccak256(
  stringToHex("MissionPolicy(uint256 chainId,uint8 missionType,address verifier,bytes32 verifierCodeHash)"),
);
const STRAVA_OAUTH_SCHEME = keccak256(stringToHex("STRAVA_OAUTH_V1"));
const CHAIN_ID = 143n;

export type PactConfiguration = Readonly<{
  stake: bigint;
  dailyTarget: number;
  durationDays: number;
  requiredCompletions: number;
  minParticipants: number;
  maxParticipants: number;
  startsAt: bigint;
  missionType: number;
}>;

/**
 * The escrow's `_missionPolicyHash`: keccak256(abi.encode(POLICY_TYPEHASH, chainid, missionType, scheme)).
 *
 * The typehash string still names a verifier and a verifier code hash, neither of which exists under
 * STRAVA_OAUTH_V1. It stays exactly as deployed anyway: it is a domain-separation constant, and correcting
 * the wording would change the hash and orphan the live escrow.
 */
export function missionPolicyIdForType(missionType: number): Hash {
  if (missionType !== 1) throw new Error("Unsupported mission");
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }],
    [POLICY_TYPEHASH, CHAIN_ID, missionType, STRAVA_OAUTH_SCHEME],
  ));
}

export const STRAVA_MISSION_POLICY_ID = missionPolicyIdForType(1);

export function hashPactConfiguration(configuration: PactConfiguration): Hash {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint96" },
      { type: "uint32" },
      { type: "uint8" },
      { type: "uint8" },
      { type: "uint8" },
      { type: "uint8" },
      { type: "uint64" },
      { type: "uint8" },
      { type: "bytes32" },
    ],
    [
      configuration.stake,
      configuration.dailyTarget,
      configuration.durationDays,
      configuration.requiredCompletions,
      configuration.minParticipants,
      configuration.maxParticipants,
      configuration.startsAt,
      configuration.missionType,
      missionPolicyIdForType(configuration.missionType),
    ],
  ));
}

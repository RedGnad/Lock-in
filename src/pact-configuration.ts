import { encodeAbiParameters, keccak256, stringToHex, type Hash } from "viem";

export const STRAVA_MISSION_POLICY_ID = keccak256(stringToHex("LOCK_IN_POLICY_STRAVA_RUN"));

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

export function missionPolicyIdForType(missionType: number): Hash {
  if (missionType === 1) return STRAVA_MISSION_POLICY_ID;
  throw new Error("Unsupported mission");
}

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

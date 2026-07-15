import type { Address, Hash } from "viem";

/** Exact public getter shape of the final LockInEscrow Pact struct. */
export type ReleasePactTuple = readonly [
  creator: Address,
  startsAt: bigint,
  stake: bigint,
  dailyTarget: number,
  participantCount: number,
  finisherCount: number,
  claimsRemaining: number,
  durationDays: number,
  requiredCompletions: number,
  minParticipants: number,
  maxParticipants: number,
  missionType: number,
  completionPauseGenerationAtCreation: bigint,
  missionPolicyHash: Hash,
  remainingPool: bigint,
  finalized: boolean,
  cancelled: boolean,
];

export const releasePactAbi = [{
  type: "function",
  name: "pacts",
  stateMutability: "view",
  inputs: [{ name: "", type: "uint256" }],
  outputs: [
    { name: "creator", type: "address" },
    { name: "startsAt", type: "uint64" },
    { name: "stake", type: "uint96" },
    { name: "dailyTarget", type: "uint32" },
    { name: "participantCount", type: "uint32" },
    { name: "finisherCount", type: "uint32" },
    { name: "claimsRemaining", type: "uint32" },
    { name: "durationDays", type: "uint8" },
    { name: "requiredCompletions", type: "uint8" },
    { name: "minParticipants", type: "uint8" },
    { name: "maxParticipants", type: "uint8" },
    { name: "missionType", type: "uint8" },
    { name: "completionPauseGenerationAtCreation", type: "uint64" },
    { name: "missionPolicyHash", type: "bytes32" },
    { name: "remainingPool", type: "uint256" },
    { name: "finalized", type: "bool" },
    { name: "cancelled", type: "bool" },
  ],
}] as const;

export const releaseMetadataAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "MAX_PARTICIPANTS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "SUBMISSION_GRACE_PERIOD", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

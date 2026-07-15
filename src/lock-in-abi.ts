import type { Address, Hash, Hex } from "viem";

export type PactTuple = readonly [
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
  missionType: number,
  missionKey: Hash,
  remainingPool: bigint,
  finalized: boolean,
  cancelled: boolean,
];

export type BaselineEvidence = readonly [
  identityHash: Hash,
  totalMetric: bigint,
  proofHash: Hash,
  observedAt: bigint,
  expiresAt: bigint,
  signature: Hex,
];

export type CompletionEvidence = readonly [
  identityHash: Hash,
  eventNullifier: Hash,
  metric: bigint,
  proofHash: Hash,
  occurredAt: bigint,
  expiresAt: bigint,
  signature: Hex,
];

export const STRAVA_RUN_MISSION = 1;
export const DUOLINGO_XP_MISSION = 2;
export const emptyBaselineEvidence: BaselineEvidence = [
  `0x${"00".repeat(32)}`,
  0n,
  `0x${"00".repeat(32)}`,
  0n,
  0n,
  "0x",
];

const baselineComponents = [
  { name: "identityHash", type: "bytes32" },
  { name: "totalMetric", type: "uint64" },
  { name: "proofHash", type: "bytes32" },
  { name: "observedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "signature", type: "bytes" },
] as const;

const completionComponents = [
  { name: "identityHash", type: "bytes32" },
  { name: "eventNullifier", type: "bytes32" },
  { name: "metric", type: "uint64" },
  { name: "proofHash", type: "bytes32" },
  { name: "occurredAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "signature", type: "bytes" },
] as const;

export const lockInAbi = [
  { type: "function", name: "nextPactId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "pacts", stateMutability: "view", inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "creator", type: "address" }, { name: "startsAt", type: "uint64" },
      { name: "stake", type: "uint96" }, { name: "dailyTarget", type: "uint32" },
      { name: "participantCount", type: "uint32" }, { name: "finisherCount", type: "uint32" },
      { name: "claimsRemaining", type: "uint32" }, { name: "durationDays", type: "uint8" },
      { name: "requiredCompletions", type: "uint8" }, { name: "minParticipants", type: "uint8" },
      { name: "missionType", type: "uint8" }, { name: "missionKey", type: "bytes32" },
      { name: "remainingPool", type: "uint256" }, { name: "finalized", type: "bool" },
      { name: "cancelled", type: "bool" },
    ],
  },
  { type: "function", name: "joined", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "completionBitmap", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "completionCount", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "claimed", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "lastMetric", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "participantIdentity", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_DURATION_DAYS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "joiningPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "evidencePaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function", name: "createPact", stateMutability: "nonpayable",
    inputs: [
      { name: "stake", type: "uint96" }, { name: "dailyTarget", type: "uint32" },
      { name: "durationDays", type: "uint8" }, { name: "requiredCompletions", type: "uint8" },
      { name: "minParticipants", type: "uint8" }, { name: "startsAt", type: "uint64" },
      { name: "missionType", type: "uint8" }, { name: "baseline", type: "tuple", components: baselineComponents },
    ],
    outputs: [{ name: "pactId", type: "uint256" }],
  },
  { type: "function", name: "joinPact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }, { name: "baseline", type: "tuple", components: baselineComponents }], outputs: [] },
  { type: "function", name: "submitCompletion", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }, { name: "dayIndex", type: "uint8" }, { name: "evidence", type: "tuple", components: completionComponents }], outputs: [] },
  { type: "function", name: "cancelPact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancelPactByOwner", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },
  { type: "function", name: "finalizePact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "amount", type: "uint256" }] },
  { type: "function", name: "setEvidenceSigner", stateMutability: "nonpayable", inputs: [{ name: "newSigner", type: "address" }], outputs: [] },
  { type: "function", name: "setCreationPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "setJoiningPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "setEvidencePaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  ...[
    "InvalidAddress", "InvalidTokenDecimals", "InvalidStake", "InvalidGoal", "InvalidSchedule",
    "UnsupportedMission", "PactNotFound", "CreationIsPaused", "JoiningIsPaused", "EvidenceIsPaused",
    "JoinClosed", "AlreadyJoined", "PactFull", "NotParticipant", "InvalidDay", "CompletionOutsideDay",
    "DayAlreadyCompleted", "TargetAlreadyMet", "UnderfilledPact", "SubmissionClosed", "EventAlreadyUsed",
    "InvalidEvidenceSigner", "AttestationExpired", "StaleEvidence", "InvalidProofHash", "InvalidMetric",
    "BaselineRequired", "IdentityAlreadyUsed", "IdentityMismatch", "NotCreator", "CancellationClosed",
    "AlreadyCancelled", "FinalizationTooEarly", "AlreadyFinalized", "NotFinalized", "NotEligible", "AlreadyClaimed",
  ].map((name) => ({ type: "error" as const, name, inputs: [] })),
  {
    type: "event", name: "PactCreated", anonymous: false,
    inputs: [
      { indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "creator", type: "address" },
      { indexed: true, name: "missionType", type: "uint8" }, { indexed: false, name: "stake", type: "uint256" },
      { indexed: false, name: "dailyTarget", type: "uint32" }, { indexed: false, name: "durationDays", type: "uint8" },
      { indexed: false, name: "requiredCompletions", type: "uint8" }, { indexed: false, name: "minParticipants", type: "uint8" },
      { indexed: false, name: "startsAt", type: "uint64" }, { indexed: false, name: "missionKey", type: "bytes32" },
    ],
  },
  { type: "event", name: "PactJoined", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }] },
  { type: "event", name: "IdentityBound", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: true, name: "identityHash", type: "bytes32" }] },
  { type: "event", name: "BaselineAccepted", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: true, name: "identityHash", type: "bytes32" }, { indexed: false, name: "totalMetric", type: "uint64" }] },
  { type: "event", name: "CompletionAccepted", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: true, name: "dayIndex", type: "uint8" }, { indexed: false, name: "missionType", type: "uint8" }, { indexed: false, name: "eventNullifier", type: "bytes32" }, { indexed: false, name: "metric", type: "uint64" }, { indexed: false, name: "occurredAt", type: "uint64" }] },
  { type: "event", name: "PactCancelled", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }] },
  { type: "event", name: "PactFinalized", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: false, name: "pool", type: "uint256" }, { indexed: false, name: "eligibleClaimants", type: "uint256" }, { indexed: false, name: "finishers", type: "uint256" }, { indexed: false, name: "cancelled", type: "bool" }] },
  { type: "event", name: "PayoutClaimed", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: false, name: "amount", type: "uint256" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

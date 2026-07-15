import type { Address, Hash, Hex } from "viem";
export type { AccessEvidence } from "./access-attestation";
import type { DirectProofBundle as ReclaimDirectProofBundle, OnchainProof } from "./reclaim-onchain";

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
  maxParticipants: number,
  missionType: number,
  completionPauseGenerationAtCreation: bigint,
  missionPolicyHash: Hash,
  remainingPool: bigint,
  finalized: boolean,
  cancelled: boolean,
];

export type BaselineEvidence = readonly [
  missionType: number,
  policyHash: Hash,
  sessionIdHash: Hash,
  identityHash: Hash,
  metric: bigint,
  proofSetHash: Hash,
  observedAt: bigint,
  issuedAt: bigint,
  expiresAt: bigint,
  signature: Hex,
];

export type CompletionEvidence = readonly [
  missionType: number,
  policyHash: Hash,
  sessionIdHash: Hash,
  identityHash: Hash,
  eventNullifier: Hash,
  metric: bigint,
  proofSetHash: Hash,
  occurredAt: bigint,
  oldestProofTimestamp: number,
  newestProofTimestamp: number,
  movingTimeSeconds: bigint,
  elapsedTimeSeconds: bigint,
  elevationGainMeters: bigint,
  issuedAt: bigint,
  expiresAt: bigint,
  signature: Hex,
];

export type DirectProofBundle = ReclaimDirectProofBundle;
export type ReclaimProof = OnchainProof;
export const emptyDirectProofBundle: DirectProofBundle = { sessionId: "", proofs: [] };

export const STRAVA_RUN_MISSION = 1;
export const DUOLINGO_XP_MISSION = 2;
export const emptyBaselineEvidence: BaselineEvidence = [
  0,
  `0x${"00".repeat(32)}`,
  `0x${"00".repeat(32)}`,
  `0x${"00".repeat(32)}`,
  0n,
  `0x${"00".repeat(32)}`,
  0n,
  0n,
  0n,
  "0x",
];

const baselineComponents = [
  { name: "missionType", type: "uint8" },
  { name: "policyHash", type: "bytes32" },
  { name: "sessionIdHash", type: "bytes32" },
  { name: "identityHash", type: "bytes32" },
  { name: "metric", type: "uint64" },
  { name: "proofSetHash", type: "bytes32" },
  { name: "observedAt", type: "uint64" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "signature", type: "bytes" },
] as const;

const completionComponents = [
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
  { name: "signature", type: "bytes" },
] as const;

export const reclaimClaimInfoComponents = [
  { name: "provider", type: "string" },
  { name: "parameters", type: "string" },
  { name: "context", type: "string" },
] as const;

export const reclaimCompleteClaimComponents = [
  { name: "identifier", type: "bytes32" },
  { name: "owner", type: "address" },
  { name: "timestampS", type: "uint32" },
  { name: "epoch", type: "uint32" },
] as const;

export const reclaimSignedClaimComponents = [
  { name: "claim", type: "tuple", components: reclaimCompleteClaimComponents },
  { name: "signatures", type: "bytes[]" },
] as const;

export const reclaimProofComponents = [
  { name: "claimInfo", type: "tuple", components: reclaimClaimInfoComponents },
  { name: "signedClaim", type: "tuple", components: reclaimSignedClaimComponents },
] as const;

export const directProofBundleComponents = [
  { name: "sessionId", type: "string" },
  { name: "proofs", type: "tuple[]", components: reclaimProofComponents },
] as const;

const accessComponents = [
  { name: "configHash", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "signature", type: "bytes" },
] as const satisfies readonly unknown[];

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
      { name: "maxParticipants", type: "uint8" },
      { name: "missionType", type: "uint8" },
      { name: "completionPauseGenerationAtCreation", type: "uint64" },
      { name: "missionPolicyHash", type: "bytes32" },
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
  { type: "function", name: "playerHandle", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "handleOwner", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "playerProfileHidden", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "lockScore", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "missionIdentityOwner", stateMutability: "view", inputs: [{ name: "", type: "uint8" }, { name: "", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "verifiedDays", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint32" }] },
  { type: "function", name: "missionVerifiedDays", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint8" }], outputs: [{ name: "", type: "uint32" }] },
  { type: "function", name: "LOCK_SCORE_PER_DAY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "accessSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "stravaVerifier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "duolingoVerifier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "CONTRACT_SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_DURATION_DAYS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "SUBMISSION_GRACE_PERIOD", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "hashPactConfiguration", stateMutability: "view",
    inputs: [
      { name: "stake", type: "uint96" }, { name: "dailyTarget", type: "uint32" },
      { name: "durationDays", type: "uint8" }, { name: "requiredCompletions", type: "uint8" },
      { name: "minParticipants", type: "uint8" }, { name: "maxParticipants", type: "uint8" },
      { name: "startsAt", type: "uint64" }, { name: "missionType", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function", name: "pactConfigHash", stateMutability: "view",
    inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function", name: "missionPolicyHash", stateMutability: "view",
    inputs: [{ name: "missionType", type: "uint8" }], outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function", name: "stravaChallenge", stateMutability: "view",
    inputs: [{ name: "pactId", type: "uint256" }, { name: "account", type: "address" }, { name: "dayIndex", type: "uint8" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function", name: "pactSubmissionDeadline", stateMutability: "view",
    inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "joiningPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "baselinePaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "completionPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "completionPauseEndedAt", stateMutability: "view", inputs: [{ name: "", type: "uint64" }], outputs: [{ name: "", type: "uint64" }] },
  {
    type: "function", name: "createPact", stateMutability: "nonpayable",
    inputs: [
      { name: "stake", type: "uint96" }, { name: "dailyTarget", type: "uint32" },
      { name: "durationDays", type: "uint8" }, { name: "requiredCompletions", type: "uint8" },
      { name: "minParticipants", type: "uint8" }, { name: "maxParticipants", type: "uint8" },
      { name: "startsAt", type: "uint64" },
      { name: "missionType", type: "uint8" }, { name: "baseline", type: "tuple", components: baselineComponents },
      { name: "directProof", type: "tuple", components: directProofBundleComponents },
      { name: "access", type: "tuple", components: accessComponents },
    ],
    outputs: [{ name: "pactId", type: "uint256" }],
  },
  { type: "function", name: "joinPact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }, { name: "baseline", type: "tuple", components: baselineComponents }, { name: "directProof", type: "tuple", components: directProofBundleComponents }, { name: "access", type: "tuple", components: accessComponents }], outputs: [] },
  { type: "function", name: "submitCompletion", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }, { name: "dayIndex", type: "uint8" }, { name: "evidence", type: "tuple", components: completionComponents }, { name: "directProof", type: "tuple", components: directProofBundleComponents }], outputs: [] },
  { type: "function", name: "cancelPact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancelPactByOwner", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },
  { type: "function", name: "finalizePact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "amount", type: "uint256" }] },
  { type: "function", name: "releaseDuolingoIdentity", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "released", type: "bool" }] },
  { type: "function", name: "setPlayerHandle", stateMutability: "nonpayable", inputs: [{ name: "handle", type: "string" }], outputs: [] },
  { type: "function", name: "clearPlayerHandle", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "highFive", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }, { name: "to", type: "address" }, { name: "dayIndex", type: "uint8" }], outputs: [] },
  { type: "function", name: "setEvidenceSigner", stateMutability: "nonpayable", inputs: [{ name: "newSigner", type: "address" }], outputs: [] },
  { type: "function", name: "setAccessSigner", stateMutability: "nonpayable", inputs: [{ name: "newSigner", type: "address" }], outputs: [] },
  { type: "function", name: "setPlayerProfileHidden", stateMutability: "nonpayable", inputs: [{ name: "account", type: "address" }, { name: "hidden", type: "bool" }], outputs: [] },
  { type: "function", name: "setCreationPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "setJoiningPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "setBaselinePaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  { type: "function", name: "setCompletionPaused", stateMutability: "nonpayable", inputs: [{ name: "paused", type: "bool" }], outputs: [] },
  ...[
    "InvalidAddress", "InvalidTokenDecimals", "InvalidStake", "InvalidGoal", "InvalidSchedule",
    "UnsupportedMission", "PactNotFound", "CreationIsPaused", "JoiningIsPaused", "BaselineIsPaused", "CompletionIsPaused",
    "JoinClosed", "AlreadyJoined", "PactFull", "NotParticipant", "InvalidDay", "CompletionOutsideDay",
    "DayAlreadyCompleted", "TargetAlreadyMet", "UnderfilledPact", "SubmissionClosed", "EventAlreadyUsed",
    "InvalidEvidenceSigner", "InvalidAccessSigner", "AccessAlreadyUsed", "AttestationExpired", "InvalidAttestationWindow", "InvalidConfigurationHash", "StaleEvidence", "InvalidProofHash", "InvalidProofBundle", "DirectProofMismatch", "InvalidMissionPolicy", "InvalidMetric",
    "BaselineRequired", "IdentityAlreadyUsed", "IdentityMismatch", "NotCreator", "CancellationClosed",
    "AlreadyCancelled", "FinalizationTooEarly", "AlreadyFinalized", "NotFinalized", "NotEligible", "AlreadyClaimed", "DuolingoIdentityInActivePact", "PactStillActive", "UnsupportedStakeToken",
    "InvalidHandle", "HandleAlreadyUsed", "InvalidHighFive", "HighFiveAlreadySent",
  ].map((name) => ({ type: "error" as const, name, inputs: [] })),
  {
    type: "event", name: "PactCreated", anonymous: false,
    inputs: [
      { indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "creator", type: "address" },
      { indexed: true, name: "missionType", type: "uint8" }, { indexed: false, name: "stake", type: "uint256" },
      { indexed: false, name: "dailyTarget", type: "uint32" }, { indexed: false, name: "durationDays", type: "uint8" },
      { indexed: false, name: "requiredCompletions", type: "uint8" }, { indexed: false, name: "minParticipants", type: "uint8" },
      { indexed: false, name: "maxParticipants", type: "uint8" },
      { indexed: false, name: "startsAt", type: "uint64" }, { indexed: false, name: "missionPolicyHash", type: "bytes32" },
    ],
  },
  { type: "event", name: "PactJoined", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }] },
  { type: "event", name: "IdentityBound", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: true, name: "identityHash", type: "bytes32" }] },
  { type: "event", name: "BaselineAccepted", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: true, name: "identityHash", type: "bytes32" }, { indexed: false, name: "totalMetric", type: "uint64" }] },
  { type: "event", name: "DuolingoIdentityReleased", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: true, name: "identityHash", type: "bytes32" }] },
  { type: "event", name: "CompletionAccepted", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: true, name: "dayIndex", type: "uint8" }, { indexed: false, name: "missionType", type: "uint8" }, { indexed: false, name: "eventNullifier", type: "bytes32" }, { indexed: false, name: "metric", type: "uint64" }, { indexed: false, name: "occurredAt", type: "uint64" }] },
  { type: "event", name: "PactCancelled", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }] },
  { type: "event", name: "PactFinalized", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: false, name: "pool", type: "uint256" }, { indexed: false, name: "eligibleClaimants", type: "uint256" }, { indexed: false, name: "finishers", type: "uint256" }, { indexed: false, name: "cancelled", type: "bool" }] },
  { type: "event", name: "PayoutClaimed", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "account", type: "address" }, { indexed: false, name: "amount", type: "uint256" }] },
  { type: "event", name: "PlayerHandleSet", anonymous: false, inputs: [{ indexed: true, name: "account", type: "address" }, { indexed: false, name: "handle", type: "string" }] },
  { type: "event", name: "PlayerProfileVisibilityUpdated", anonymous: false, inputs: [{ indexed: true, name: "account", type: "address" }, { indexed: false, name: "hidden", type: "bool" }] },
  { type: "event", name: "MissionDayVerified", anonymous: false, inputs: [{ indexed: true, name: "account", type: "address" }, { indexed: true, name: "missionType", type: "uint8" }, { indexed: true, name: "utcDay", type: "uint64" }, { indexed: false, name: "missionVerifiedDays", type: "uint32" }] },
  { type: "event", name: "LockScoreAwarded", anonymous: false, inputs: [{ indexed: true, name: "account", type: "address" }, { indexed: true, name: "utcDay", type: "uint64" }, { indexed: false, name: "scoreAwarded", type: "uint64" }, { indexed: false, name: "totalScore", type: "uint64" }, { indexed: false, name: "verifiedDays", type: "uint32" }] },
  { type: "event", name: "MissionIdentityBound", anonymous: false, inputs: [{ indexed: true, name: "missionType", type: "uint8" }, { indexed: true, name: "identityHash", type: "bytes32" }, { indexed: true, name: "account", type: "address" }] },
  { type: "event", name: "HighFiveSent", anonymous: false, inputs: [{ indexed: true, name: "pactId", type: "uint256" }, { indexed: true, name: "from", type: "address" }, { indexed: true, name: "to", type: "address" }, { indexed: false, name: "dayIndex", type: "uint8" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

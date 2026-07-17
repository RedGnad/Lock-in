/**
 * The client ABI for LockInDuolingoEscrow (contract B). Mirrors the Strava escrow's lock-in-abi.ts but for
 * the cumulative XP delta: createPact carries a bytes32 createNonce and a BaselineEvidence, submitFinal a
 * FinalEvidence. The struct tuples match the contract byte for byte; the reader in duolingo-escrow-chain
 * imports duoPactComponents from here so the two never drift.
 */

export const duoPactComponents = [
  { name: "creator", type: "address" },
  { name: "startsAt", type: "uint64" },
  { name: "durationSeconds", type: "uint32" },
  { name: "stake", type: "uint96" },
  { name: "targetXp", type: "uint32" },
  { name: "participantCount", type: "uint32" },
  { name: "finisherCount", type: "uint32" },
  { name: "claimsRemaining", type: "uint32" },
  { name: "minParticipants", type: "uint8" },
  { name: "maxParticipants", type: "uint8" },
  { name: "completionPauseGenerationAtCreation", type: "uint64" },
  { name: "missionPolicyHash", type: "bytes32" },
  { name: "configHash", type: "bytes32" },
  { name: "remainingPool", type: "uint256" },
  { name: "finalized", type: "bool" },
  { name: "cancelled", type: "bool" },
] as const;

const baselineEvidenceComponents = [
  { name: "configHash", type: "bytes32" },
  { name: "identityHash", type: "bytes32" },
  { name: "nullifier", type: "bytes32" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "signature", type: "bytes" },
] as const;

const finalEvidenceComponents = [
  { name: "identityHash", type: "bytes32" },
  { name: "earnedXp", type: "uint32" },
  { name: "targetXp", type: "uint32" },
  { name: "nullifier", type: "bytes32" },
  { name: "occurredAt", type: "uint64" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "signature", type: "bytes" },
] as const;

export const lockInDuolingoAbi = [
  // --- views ---
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_STAKE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "evidenceSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "joiningPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "completionPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "getPact", stateMutability: "view", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "tuple", components: duoPactComponents }] },
  { type: "function", name: "pactConfigHash", stateMutability: "view", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "pactEndsAt", stateMutability: "view", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "pactSubmissionDeadline", stateMutability: "view", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "isFinisher", stateMutability: "view", inputs: [{ name: "pactId", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "joined", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "completed", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "claimed", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },

  // --- writes ---
  {
    type: "function", name: "createPact", stateMutability: "nonpayable",
    inputs: [
      { name: "stake", type: "uint96" },
      { name: "targetXp", type: "uint32" },
      { name: "durationSeconds", type: "uint32" },
      { name: "minParticipants", type: "uint8" },
      { name: "maxParticipants", type: "uint8" },
      { name: "startsAt", type: "uint64" },
      { name: "createNonce", type: "bytes32" },
      { name: "baseline", type: "tuple", components: baselineEvidenceComponents },
    ],
    outputs: [{ name: "pactId", type: "uint256" }],
  },
  {
    type: "function", name: "joinPact", stateMutability: "nonpayable",
    inputs: [
      { name: "pactId", type: "uint256" },
      { name: "baseline", type: "tuple", components: baselineEvidenceComponents },
    ],
    outputs: [],
  },
  {
    type: "function", name: "submitFinal", stateMutability: "nonpayable",
    inputs: [
      { name: "pactId", type: "uint256" },
      { name: "evidence", type: "tuple", components: finalEvidenceComponents },
    ],
    outputs: [],
  },
  { type: "function", name: "finalizePact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "amount", type: "uint256" }] },
  { type: "function", name: "cancelPact", stateMutability: "nonpayable", inputs: [{ name: "pactId", type: "uint256" }], outputs: [] },

  // --- events ---
  {
    type: "event", name: "PactCreated", inputs: [
      { name: "pactId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "stake", type: "uint96", indexed: false },
      { name: "targetXp", type: "uint32", indexed: false },
      { name: "durationSeconds", type: "uint32", indexed: false },
      { name: "minParticipants", type: "uint8", indexed: false },
      { name: "maxParticipants", type: "uint8", indexed: false },
      { name: "startsAt", type: "uint64", indexed: false },
      { name: "configHash", type: "bytes32", indexed: false },
      { name: "missionPolicyHash", type: "bytes32", indexed: false },
    ],
  },
  { type: "event", name: "PactJoined", inputs: [{ name: "pactId", type: "uint256", indexed: true }, { name: "account", type: "address", indexed: true }] },
  { type: "event", name: "CompletionVerified", inputs: [{ name: "pactId", type: "uint256", indexed: true }, { name: "account", type: "address", indexed: true }, { name: "targetXp", type: "uint32", indexed: false }, { name: "occurredAt", type: "uint64", indexed: false }] },
  { type: "event", name: "PactFinalized", inputs: [{ name: "pactId", type: "uint256", indexed: true }, { name: "pool", type: "uint256", indexed: false }, { name: "eligibleClaimants", type: "uint32", indexed: false }, { name: "finisherCount", type: "uint32", indexed: false }, { name: "cancelled", type: "bool", indexed: false }] },
  { type: "event", name: "PayoutClaimed", inputs: [{ name: "pactId", type: "uint256", indexed: true }, { name: "account", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "PactCancelled", inputs: [{ name: "pactId", type: "uint256", indexed: true }] },
] as const;

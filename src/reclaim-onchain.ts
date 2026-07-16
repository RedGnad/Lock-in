import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  getIdentifierFromClaimInfo,
  transformForOnchain,
  type Proof,
} from "@reclaimprotocol/js-sdk";
import { reclaimProofComponents } from "./lock-in-abi";
import { STRAVA_PROOF_COUNT } from "./strava-proof-policy";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const FORBIDDEN_HEADER = /(?:cookie|authorization|token|secret|api[-_]?key)/i;
const MAX_PROOF_SET_BYTES = 192 * 1_024;
const MAX_SESSION_ID_BYTES = 128;

export const DUOLINGO_MAX_SIGNED_JSON_BYTES = 8_192;
export const STRAVA_MAX_SIGNED_JSON_BYTES = 16_384;
export const PINNED_RECLAIM_WITNESS = getAddress("0x244897572368Eadf65bfBc5aec98D8e5443a9072");

export type OnchainProof = ReturnType<typeof transformForOnchain>;

export type DirectProofBundle = Readonly<{
  sessionId: string;
  proofs: readonly OnchainProof[];
}>;

export type DirectDuolingoEvidence = Readonly<{
  identityHash: Hash;
  proofSetHash: Hash;
  totalXp: bigint;
  proofTimestamp: number;
}>;

export type DirectStravaEvidence = Readonly<{
  identityHash: Hash;
  nullifier: Hash;
  proofSetHash: Hash;
  distanceMeters: bigint;
  startTime: bigint;
  movingTimeSeconds: bigint;
  elapsedTimeSeconds: bigint;
  elevationGainMeters: bigint;
  oldestProofTimestamp: number;
  newestProofTimestamp: number;
}>;

export class HybridReleaseUnavailableError extends Error {
  constructor(message = "Hybrid proof verification is unavailable") {
    super(message);
    this.name = "HybridReleaseUnavailableError";
  }
}

export class ReclaimProofRejectedError extends Error {
  constructor(message = "The Reclaim proof was rejected") {
    super(message);
    this.name = "ReclaimProofRejectedError";
  }
}

function reject(message: string): never {
  throw new ReclaimProofRejectedError(message);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function uint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 0xffff_ffff) {
    reject(`${label} must be a uint32`);
  }
  return Number(value);
}

function inspectHeaderContainer(value: unknown): void {
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator > 0 && FORBIDDEN_HEADER.test(line.slice(0, separator).trim())) {
        reject("A signed request contains a forbidden sensitive header");
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    if (typeof value[0] === "string" && FORBIDDEN_HEADER.test(value[0])) {
      reject("A signed request contains a forbidden sensitive header");
    }
    for (const item of value) inspectHeaderContainer(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const headers = value as Record<string, unknown>;
  for (const [name, headerValue] of Object.entries(headers)) {
    if (FORBIDDEN_HEADER.test(name)) reject("A signed request contains a forbidden sensitive header");
    if (
      ["name", "key", "header"].includes(name.toLowerCase())
        && typeof headerValue === "string"
        && FORBIDDEN_HEADER.test(headerValue)
    ) {
      reject("A signed request contains a forbidden sensitive header");
    }
  }
}

function inspectSignedJson(value: string, label: string, maxBytes: number): void {
  if (utf8Bytes(value) > maxBytes) reject(`${label} is too large`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    reject(`${label} is not valid JSON`);
  }

  const visit = (node: unknown, depth: number): void => {
    if (depth > 20) reject(`${label} is nested too deeply`);
    if (Array.isArray(node)) {
      if (node.length > 512) reject(`${label} contains too many entries`);
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (Object.keys(object).length > 256) reject(`${label} contains too many fields`);
    for (const [key, child] of Object.entries(object)) {
      if (key.toLowerCase() === "headers" || key.toLowerCase() === "header") inspectHeaderContainer(child);
      visit(child, depth + 1);
    }
  };
  visit(parsed, 0);
}

/** Mirrors the RFC 8785-style serializer used by Reclaim JS SDK 5.8.2. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) reject("Signed context contains an unsupported JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function canonicalClaimContext(context: string): string {
  try {
    return canonicalJson(JSON.parse(context));
  } catch (error) {
    if (error instanceof ReclaimProofRejectedError) throw error;
    return reject("Signed Reclaim context is not valid JSON");
  }
}

/** The only terminal Reclaim state Lock In accepts. Notably NOT AI_PROOF_SUBMITTED. */
export const RECLAIM_PROOF_SUBMITTED = "PROOF_SUBMITTED";

/**
 * Guards the direct Strava verifier call. This lives here, rather than inline in the route, because an
 * inline count is exactly what silently drifted: the route kept requiring 4 proofs after the provider was
 * redesigned to 2, so every valid 6.0.0 proof was refused before reaching Solidity while the suites stayed
 * green. The count comes from STRAVA_PROOF_COUNT so the provider shape has a single source of truth.
 */
export function assertDirectStravaInput(input: {
  hasEscrow: boolean;
  proofCount: number;
  dayIndex?: number;
}): void {
  if (!input.hasEscrow) reject("The escrow address is not configured");
  if (input.proofCount !== STRAVA_PROOF_COUNT) {
    reject(`A Strava proof set must contain exactly ${STRAVA_PROOF_COUNT} proofs, received ${input.proofCount}`);
  }
  if (input.dayIndex === undefined) reject("A Strava proof must be bound to a day index");
}

export type ReclaimSessionSummary = Readonly<{
  sessionId?: string;
  appId?: string;
  providerId?: string;
  providerVersionString?: string;
  statusV2?: string;
  proofs?: unknown;
}>;

/**
 * Fail-closed provenance gate on the Reclaim session itself, checked before any proof byte is trusted.
 *
 * The signed context carries an `isAiProof` flag that Lock In deliberately does not use as a trust
 * selector (verifyProof applies signature, content pin and TEE checks regardless of it). Trust is
 * established here instead: the session must have been executed by the exact pinned provider and
 * version, under our application, and must have reached the deterministic PROOF_SUBMITTED terminal
 * state. That rejects AI_PROOF_SUBMITTED and every unknown state explicitly.
 */
export function assertReclaimSessionProvenance(input: {
  session: ReclaimSessionSummary | undefined;
  expected: Readonly<{ sessionId: string; appId: string; providerId: string; providerVersion: string }>;
}): void {
  const { session, expected } = input;
  if (!session) reject("Reclaim session is incomplete");
  if (!expected.appId) reject("Reclaim application id is not configured");
  if (session.sessionId !== expected.sessionId) reject("Reclaim session mismatch");
  if (typeof session.appId !== "string" || session.appId.toLowerCase() !== expected.appId.toLowerCase()) {
    reject("Reclaim application mismatch");
  }
  if (session.providerId !== expected.providerId) reject("Reclaim provider mismatch");
  if (session.providerVersionString !== expected.providerVersion) {
    reject("Reclaim provider version mismatch");
  }
  if (session.statusV2 !== RECLAIM_PROOF_SUBMITTED) {
    reject(`Unexpected Reclaim submission state: ${String(session.statusV2)}`);
  }
  if (!session.proofs) reject("Reclaim proof set is absent");
}

/**
 * Accept only the concrete JSON shape returned by the Reclaim SDK. In particular,
 * signatures must remain an array: accepting a hand-shaped singular signature here
 * would make SDK verification and Solidity calldata validate different objects.
 */
export function assertSdkProofSet(
  value: unknown,
  options: { expectedCount: 1 | 2; maxSignedJsonBytes: number },
): Proof[] {
  const proofs = Array.isArray(value) ? value : value ? [value] : [];
  if (proofs.length !== options.expectedCount) reject("Unexpected Reclaim proof count");

  let serialised: string;
  try {
    serialised = JSON.stringify(proofs);
  } catch {
    reject("The Reclaim proof set is not serialisable");
  }
  if (utf8Bytes(serialised) > MAX_PROOF_SET_BYTES) reject("The Reclaim proof set is too large");

  for (const [index, candidate] of proofs.entries()) {
    const proof = record(candidate, `proof ${index}`);
    const claimData = record(proof.claimData, `proof ${index} claimData`);
    if (typeof proof.identifier !== "string" || !HASH.test(proof.identifier)) reject("Invalid proof identifier");
    if (typeof claimData.identifier !== "string" || !HASH.test(claimData.identifier)) reject("Invalid claim identifier");
    if (proof.identifier.toLowerCase() !== claimData.identifier.toLowerCase()) reject("Conflicting proof identifiers");
    if (claimData.provider !== "http") reject("Unexpected Reclaim claim provider");
    if (typeof claimData.parameters !== "string" || typeof claimData.context !== "string") {
      reject("Signed Reclaim claim data is missing");
    }
    if (typeof claimData.owner !== "string" || !isAddress(claimData.owner)) reject("Invalid claim owner");
    uint32(claimData.timestampS, "claim timestamp");
    uint32(claimData.epoch, "claim epoch");
    if (!Array.isArray(proof.signatures) || proof.signatures.length !== 1 || !SIGNATURE.test(String(proof.signatures[0]))) {
      reject("A Reclaim proof must contain one SDK signature in an array");
    }
    if (!Array.isArray(proof.witnesses)) reject("Reclaim witnesses have an invalid shape");
    if (!proof.teeAttestation || typeof proof.teeAttestation !== "object") reject("TEE attestation is missing");
    inspectSignedJson(claimData.parameters, `proof ${index} parameters`, options.maxSignedJsonBytes);
    inspectSignedJson(claimData.context, `proof ${index} context`, options.maxSignedJsonBytes);
    const computedIdentifier = getIdentifierFromClaimInfo(claimData as never);
    if (computedIdentifier.toLowerCase() !== claimData.identifier.toLowerCase()) {
      reject("Signed Reclaim claim data does not match its identifier");
    }
  }
  return proofs as Proof[];
}

function assertUnchangedTransform(proof: Proof, transformed: OnchainProof): void {
  const claimInfo = record(transformed.claimInfo, "transformed claimInfo");
  const signedClaim = record(transformed.signedClaim, "transformed signedClaim");
  const claim = record(signedClaim.claim, "transformed claim");
  if (
    claimInfo.provider !== proof.claimData.provider
      || claimInfo.parameters !== proof.claimData.parameters
      || claimInfo.context !== proof.claimData.context
      || claim.identifier !== proof.claimData.identifier
      || claim.owner !== proof.claimData.owner
      || claim.timestampS !== proof.claimData.timestampS
      || claim.epoch !== proof.claimData.epoch
      || !Array.isArray(signedClaim.signatures)
      || signedClaim.signatures.length !== proof.signatures.length
      || signedClaim.signatures.some((signature, index) => signature !== proof.signatures[index])
  ) reject("The SDK onchain transform changed signed claim bytes");
}

/**
 * Returns Solidity-compatible claims. Reclaim signs the RFC 8785 canonical form
 * of context but its SDK onchain transform currently copies the raw key order.
 * Canonicalising context here preserves the signed identifier and lets Solidity
 * recompute it; parameters and every other signed field stay byte-exact.
 */
export function toDirectProofBundle(sessionId: string, proofs: readonly Proof[]): DirectProofBundle {
  if (utf8Bytes(sessionId) === 0 || utf8Bytes(sessionId) > MAX_SESSION_ID_BYTES || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    reject("Invalid Reclaim session id");
  }
  const transformed = proofs.map((proof) => {
    const onchain = transformForOnchain(proof);
    assertUnchangedTransform(proof, onchain);
    const context = canonicalClaimContext(proof.claimData.context);
    const identifier = getIdentifierFromClaimInfo({ ...proof.claimData, context } as never);
    if (identifier.toLowerCase() !== proof.claimData.identifier.toLowerCase()) {
      reject("Canonical Reclaim context does not match the signed identifier");
    }
    return { ...onchain, claimInfo: { ...onchain.claimInfo, context } };
  });
  return { sessionId, proofs: transformed };
}

export function sessionIdHash(sessionId: string): Hash {
  return keccak256(stringToHex(sessionId));
}

export function duolingoCompletionNullifier(input: {
  identityHash: Hash;
  totalXp: bigint;
  proofSetHash: Hash;
}): Hash {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 namespace, bytes32 identityHash, uint64 totalXp, bytes32 proofSetHash"),
    [keccak256(stringToHex("LOCK_IN_DUOLINGO_COMPLETION")), input.identityHash, input.totalXp, input.proofSetHash],
  ));
}

export function asDirectDuolingoEvidence(value: unknown): DirectDuolingoEvidence {
  const output = record(value, "Duolingo verifier output");
  if (typeof output.identityHash !== "string" || !HASH.test(output.identityHash)) reject("Invalid direct identity");
  if (typeof output.proofSetHash !== "string" || !HASH.test(output.proofSetHash)) reject("Invalid direct proof hash");
  const totalXp = typeof output.totalXp === "bigint" ? output.totalXp : BigInt(String(output.totalXp));
  const proofTimestamp = uint32(output.proofTimestamp, "direct proof timestamp");
  return {
    identityHash: output.identityHash as Hash,
    proofSetHash: output.proofSetHash as Hash,
    totalXp,
    proofTimestamp,
  };
}

export function asDirectStravaEvidence(value: unknown): DirectStravaEvidence {
  const output = record(value, "Strava verifier output");
  for (const field of ["identityHash", "nullifier", "proofSetHash"] as const) {
    if (typeof output[field] !== "string" || !HASH.test(output[field])) reject(`Invalid direct ${field}`);
  }
  const bigintField = (field: string): bigint => {
    const value = output[field];
    try {
      return typeof value === "bigint" ? value : BigInt(String(value));
    } catch {
      return reject(`Invalid direct ${field}`);
    }
  };
  return {
    identityHash: output.identityHash as Hash,
    nullifier: output.nullifier as Hash,
    proofSetHash: output.proofSetHash as Hash,
    distanceMeters: bigintField("distanceMeters"),
    startTime: bigintField("startTime"),
    movingTimeSeconds: bigintField("movingTimeSeconds"),
    elapsedTimeSeconds: bigintField("elapsedTimeSeconds"),
    elevationGainMeters: bigintField("elevationGainMeters"),
    oldestProofTimestamp: uint32(output.oldestProofTimestamp, "oldest proof timestamp"),
    newestProofTimestamp: uint32(output.newestProofTimestamp, "newest proof timestamp"),
  };
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function assertDuolingoDirectParity(input: {
  direct: DirectDuolingoEvidence;
  policy: { identityHash: Hash; totalXp: number; observedAt: number };
  proofSetHash: Hash;
}): void {
  if (
    !sameHash(input.direct.identityHash, input.policy.identityHash)
      || input.direct.totalXp !== BigInt(input.policy.totalXp)
      || !sameHash(input.direct.proofSetHash, input.proofSetHash)
      || input.direct.proofTimestamp !== input.policy.observedAt
  ) reject("Duolingo policy and direct verification disagree");
}

export function assertStravaDirectParity(input: {
  direct: DirectStravaEvidence;
  policy: {
    identityHash: Hash;
    nullifier: Hash;
    distanceMeters: number;
    startTimeMs: number;
    movingTimeSeconds: number;
    elapsedTimeSeconds: number;
    elevationGainMeters: number;
  };
  proofSetHash: Hash;
  timestamps: readonly number[];
}): void {
  if (input.timestamps.length !== 2) reject("Strava timestamp count mismatch");
  if (
    !sameHash(input.direct.identityHash, input.policy.identityHash)
      || !sameHash(input.direct.nullifier, input.policy.nullifier)
      || !sameHash(input.direct.proofSetHash, input.proofSetHash)
      || input.direct.distanceMeters !== BigInt(input.policy.distanceMeters)
      || input.direct.startTime !== BigInt(Math.floor(input.policy.startTimeMs / 1_000))
      || input.direct.movingTimeSeconds !== BigInt(input.policy.movingTimeSeconds)
      || input.direct.elapsedTimeSeconds !== BigInt(input.policy.elapsedTimeSeconds)
      || input.direct.elevationGainMeters !== BigInt(input.policy.elevationGainMeters)
      || input.direct.oldestProofTimestamp !== Math.min(...input.timestamps)
      || input.direct.newestProofTimestamp !== Math.max(...input.timestamps)
  ) reject("Strava policy and direct verification disagree");
}

export function assertAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new HybridReleaseUnavailableError(`${label} is absent`);
  return getAddress(value);
}

export function assertHash(value: unknown, label: string): Hash {
  if (typeof value !== "string" || !HASH.test(value)) throw new HybridReleaseUnavailableError(`${label} is absent`);
  return value as Hash;
}

export function assertPinnedHybridDeployment(input: {
  observedStravaVerifier: Address;
  configuredStravaVerifier: Address;
  observedDuolingoVerifier: Address;
  configuredDuolingoVerifier: Address;
  stravaWitness: Address;
  duolingoWitness: Address;
  configuredWitness?: Address;
}): void {
  if (
    getAddress(input.observedStravaVerifier) !== getAddress(input.configuredStravaVerifier)
      || getAddress(input.observedDuolingoVerifier) !== getAddress(input.configuredDuolingoVerifier)
  ) throw new HybridReleaseUnavailableError("Escrow verifier address mismatch");
  if (
    getAddress(input.stravaWitness) !== PINNED_RECLAIM_WITNESS
      || getAddress(input.duolingoWitness) !== PINNED_RECLAIM_WITNESS
      || input.configuredWitness && getAddress(input.configuredWitness) !== PINNED_RECLAIM_WITNESS
  ) throw new HybridReleaseUnavailableError("Pinned Reclaim witness mismatch");
}

export function asHexSignature(value: unknown): Hex {
  if (typeof value !== "string" || !SIGNATURE.test(value)) reject("Invalid evidence signature");
  return value as Hex;
}

const duolingoEvidenceComponents = [
  { name: "identityHash", type: "bytes32" },
  { name: "proofSetHash", type: "bytes32" },
  { name: "totalXp", type: "uint64" },
  { name: "proofTimestamp", type: "uint32" },
] as const;

const stravaPolicyComponents = [
  { name: "account", type: "address" },
  { name: "pactId", type: "uint256" },
  { name: "dayIndex", type: "uint8" },
  { name: "expectedSessionId", type: "string" },
  { name: "challenge", type: "string" },
  { name: "startsAt", type: "uint64" },
  { name: "endsAt", type: "uint64" },
  { name: "minDistanceMeters", type: "uint64" },
] as const;

const stravaEvidenceComponents = [
  { name: "identityHash", type: "bytes32" },
  { name: "nullifier", type: "bytes32" },
  { name: "proofSetHash", type: "bytes32" },
  { name: "distanceMeters", type: "uint64" },
  { name: "startTime", type: "uint64" },
  { name: "movingTimeSeconds", type: "uint64" },
  { name: "elapsedTimeSeconds", type: "uint64" },
  { name: "elevationGainMeters", type: "uint64" },
  { name: "oldestProofTimestamp", type: "uint32" },
  { name: "newestProofTimestamp", type: "uint32" },
] as const;

export const duolingoVerifierAbi = [
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "DUOLINGO_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "DUOLINGO_OWNERSHIP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "DUOLINGO_XP_REQUEST_HASH", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "WITNESS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "validateDuolingoProofs", stateMutability: "view",
    inputs: [
      { name: "proofs", type: "tuple[]", components: reclaimProofComponents },
      { name: "account", type: "address" },
      { name: "pactId", type: "uint256" },
      { name: "baseline", type: "bool" },
      { name: "dayIndex", type: "uint8" },
      { name: "expectedSessionId", type: "string" },
    ],
    outputs: [{ name: "evidence", type: "tuple", components: duolingoEvidenceComponents }],
  },
] as const;

export const stravaVerifierAbi = [
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "STRAVA_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "STRAVA_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "WITNESS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "PARSER", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "validateStravaProofs", stateMutability: "view",
    inputs: [
      { name: "proofs", type: "tuple[]", components: reclaimProofComponents },
      { name: "policy", type: "tuple", components: stravaPolicyComponents },
    ],
    outputs: [{ name: "evidence", type: "tuple", components: stravaEvidenceComponents }],
  },
] as const;

export const stravaParserAbi = [
  { type: "function", name: "LIVE_SCHEMA_CONFIRMED", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "SCHEMA_ID", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "STRAVA_PROVIDER_ID", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "STRAVA_PROVIDER_VERSION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

import type { Hex } from "viem";

/**
 * Pure client-side logic for the financial Duolingo flow: which mode the UI is in, parsing the backend's
 * attestations, checking they are still fresh enough to send, and building the exact on-chain arguments.
 *
 * None of this touches wagmi or the network, so the parts a mistake would be most expensive in, the mapping
 * from a signed attestation to a transaction, are unit-tested in isolation.
 */

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT_STRING = /^(?:0|[1-9]\d*)$/;

export type DuolingoModeStatus = "live-proof" | "canary-paused" | "live-usdc";
export type DuolingoMode = Readonly<{ status: DuolingoModeStatus; badge: string; canTransact: boolean }>;

/**
 * The three display modes, in order of increasing trust:
 * - no escrow address at all: the Live Proof Beta, stake selector shown but disabled, no transactions;
 * - address present but the contract is paused (or the signer has not been verified on-chain): the
 *   financial canary, terms visible but every write blocked;
 * - address present, nothing paused, signer verified: live with USDC.
 * `anyPaused === null` means the chain has not been read yet, and is treated as paused, never as open.
 */
export function resolveDuolingoMode(input: {
  hasAddress: boolean;
  anyPaused: boolean | null;
  signerVerified?: boolean;
}): DuolingoMode {
  if (!input.hasAddress) {
    return { status: "live-proof", badge: "BETA · LIVE PROOF", canTransact: false };
  }
  if (input.anyPaused !== false || input.signerVerified === false) {
    return { status: "canary-paused", badge: "BETA · FINANCIAL CANARY PAUSED", canTransact: false };
  }
  return { status: "live-usdc", badge: "BETA · LIVE WITH USDC · 1 USDC MAX", canTransact: true };
}

export type BaselineEvidence = Readonly<{
  configHash: Hex;
  identityHash: Hex;
  nullifier: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
  signature: Hex;
}>;

export type FinalEvidence = Readonly<{
  identityHash: Hex;
  earnedXp: number;
  targetXp: number;
  nullifier: Hex;
  occurredAt: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
  signature: Hex;
}>;

function hex(value: unknown, pattern: RegExp, label: string): Hex {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label} in the attestation`);
  return value as Hex;
}

function bigintFrom(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !UINT_STRING.test(value)) throw new Error(`Invalid ${label} in the attestation`);
  return BigInt(value);
}

function uint32(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`Invalid ${label} in the attestation`);
  }
  return value;
}

/** Parses the JSON baseline attestation the verify route returns into typed, on-chain-ready fields. */
export function parseBaselineEvidence(raw: unknown): BaselineEvidence {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    configHash: hex(o.configHash, BYTES32, "config hash"),
    identityHash: hex(o.identityHash, BYTES32, "identity"),
    nullifier: hex(o.nullifier, BYTES32, "nullifier"),
    issuedAt: bigintFrom(o.issuedAt, "issued time"),
    expiresAt: bigintFrom(o.expiresAt, "expiry"),
    signature: hex(o.signature, SIGNATURE, "signature"),
  };
}

/** Parses the JSON final attestation the verify route returns. */
export function parseFinalEvidence(raw: unknown): FinalEvidence {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    identityHash: hex(o.identityHash, BYTES32, "identity"),
    earnedXp: uint32(o.earnedXp, "earned XP"),
    targetXp: uint32(o.targetXp, "target XP"),
    nullifier: hex(o.nullifier, BYTES32, "nullifier"),
    occurredAt: bigintFrom(o.occurredAt, "observed time"),
    issuedAt: bigintFrom(o.issuedAt, "issued time"),
    expiresAt: bigintFrom(o.expiresAt, "expiry"),
    signature: hex(o.signature, SIGNATURE, "signature"),
  };
}

/**
 * A margin, in seconds, before an attestation's on-chain expiry within which the UI refuses to send it. The
 * contract rejects anything already expired; sending one seconds from expiry loses the gas to a revert.
 * Wide enough to survive an approve transaction landing before the create.
 */
export const ATTESTATION_SAFETY_MARGIN_SECONDS = 90;

/** Whether an attestation is still far enough from expiry to be worth sending. */
export function attestationIsFresh(
  expiresAt: bigint,
  nowSeconds = Math.floor(Date.now() / 1_000),
  marginSeconds = ATTESTATION_SAFETY_MARGIN_SECONDS,
): boolean {
  return expiresAt > BigInt(nowSeconds + marginSeconds);
}

export type CreateTerms = Readonly<{
  stake: bigint;
  targetXp: number;
  durationSeconds: number;
  minParticipants: number;
  maxParticipants: number;
  startsAt: bigint;
  createNonce: Hex;
}>;

/** The exact positional arguments for createPact, baseline passed as the struct object viem expects. */
export function createPactArgs(terms: CreateTerms, baseline: BaselineEvidence) {
  if (!BYTES32.test(terms.createNonce)) throw new Error("Invalid create nonce");
  return [
    terms.stake,
    terms.targetXp,
    terms.durationSeconds,
    terms.minParticipants,
    terms.maxParticipants,
    terms.startsAt,
    terms.createNonce,
    baseline,
  ] as const;
}

export function joinPactArgs(pactId: bigint, baseline: BaselineEvidence) {
  return [pactId, baseline] as const;
}

export function submitFinalArgs(pactId: bigint, evidence: FinalEvidence) {
  return [pactId, evidence] as const;
}

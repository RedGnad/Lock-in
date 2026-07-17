import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  numberToHex,
  parseAbiParameters,
  stringToHex,
  type Hex,
} from "viem";
import {
  duolingoIdentityHash,
  signBaseline,
  signFinal,
  type BaselineMessage,
  type FinalMessage,
} from "./duolingo-attestation";

/**
 * The financial half of the Duolingo escrow: turning a TEE-verified Reclaim proof into the exact EIP-712
 * attestation LockInDuolingoEscrow accepts. This module never touches the network; it derives the on-chain
 * identity, the phase-scoped nullifier and the signed context, and signs. The routes read the chain and the
 * store around it.
 *
 * The signer of these attestations is a trusted party: a compromised DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY
 * can mint completions that never happened, exactly as documented on the contract. Everything here is
 * deterministic and pinned so the same proof always yields the same nullifier, which is what makes a
 * resubmission after a reverted transaction safe rather than a second unlock.
 */

export type EscrowIntent = "create" | "join" | "final";

/** A short attestation lifetime, well inside the contract's MAX_ATTESTATION_AGE (10 min). */
export const ESCROW_ATTESTATION_TTL_SECONDS = 5 * 60;

const NULLIFIER_NAMESPACE = keccak256(stringToHex("LOCK_IN_DUOLINGO_ESCROW_V1"));
const PHASE_CREATE = keccak256(stringToHex("create"));
const PHASE_JOIN = keccak256(stringToHex("join"));
const PHASE_FINAL = keccak256(stringToHex("final"));

const CREATE_NONCE = /^0x[0-9a-fA-F]{64}$/;

export function isCreateNonce(value: string): value is Hex {
  return CREATE_NONCE.test(value);
}

/**
 * The escrow B address the attestation is bound to, as the EIP-712 `verifyingContract`.
 *
 * Until the contract is deployed and pinned, this is unset and the backend refuses to sign: an attestation
 * bound to no address, or to the wrong one, is worthless. The value must be a real checksummed address.
 */
export function escrowVerifyingContract(environment: Record<string, string | undefined> = process.env): Hex {
  const value = environment.DUOLINGO_ESCROW_ADDRESS?.trim();
  if (!value || !isAddress(value)) throw new Error("DUOLINGO_ESCROW_ADDRESS is not configured");
  return getAddress(value);
}

/**
 * The signed Reclaim `contextMessage` for a phase.
 *
 * A create baseline is bound to the server createNonce (no pactId exists yet); a join baseline and a final
 * are bound to the pactId. The phase word is included so a baseline can never be presented as a final.
 */
export function escrowContextMessage(
  input:
    | { intent: "create"; createNonce: Hex }
    | { intent: "join"; pactId: bigint }
    | { intent: "final"; pactId: bigint },
): string {
  if (input.intent === "create") {
    if (!isCreateNonce(input.createNonce)) throw new Error("Invalid create nonce");
    return `escrow:create:${input.createNonce.toLowerCase()}:baseline`;
  }
  if (input.pactId <= 0n) throw new Error("Invalid pact id");
  return input.intent === "join"
    ? `escrow:join:${input.pactId}:baseline`
    : `escrow:final:${input.pactId}:final`;
}

function nullifier(identityHash: Hex, phase: Hex, binding: Hex): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 namespace, bytes32 identityHash, bytes32 phase, bytes32 binding"),
    [NULLIFIER_NAMESPACE, identityHash, phase, binding],
  ));
}

export function escrowBaselineNullifier(
  input:
    | { identityHash: Hex; intent: "create"; createNonce: Hex }
    | { identityHash: Hex; intent: "join"; pactId: bigint },
): Hex {
  if (input.intent === "create") {
    if (!isCreateNonce(input.createNonce)) throw new Error("Invalid create nonce");
    return nullifier(input.identityHash, PHASE_CREATE, input.createNonce.toLowerCase() as Hex);
  }
  if (input.pactId <= 0n) throw new Error("Invalid pact id");
  return nullifier(input.identityHash, PHASE_JOIN, numberToHex(input.pactId, { size: 32 }));
}

export function escrowFinalNullifier(input: { identityHash: Hex; pactId: bigint }): Hex {
  if (input.pactId <= 0n) throw new Error("Invalid pact id");
  return nullifier(input.identityHash, PHASE_FINAL, numberToHex(input.pactId, { size: 32 }));
}

/** issuedAt now, a short expiry inside MAX_ATTESTATION_AGE, both as the contract wants uint64. */
export function escrowAttestationWindow(nowSeconds = Math.floor(Date.now() / 1_000)): {
  issuedAt: bigint;
  expiresAt: bigint;
} {
  const issuedAt = BigInt(nowSeconds);
  return { issuedAt, expiresAt: issuedAt + BigInt(ESCROW_ATTESTATION_TTL_SECONDS) };
}

export type BaselineAttestation = Readonly<{
  configHash: Hex;
  identityHash: Hex;
  nullifier: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
  signature: Hex;
}>;

export type FinalAttestation = Readonly<{
  identityHash: Hex;
  earnedXp: number;
  targetXp: number;
  nullifier: Hex;
  occurredAt: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
  signature: Hex;
}>;

/**
 * The complete baseline attestation for create or join: the client submits these fields as the contract's
 * BaselineEvidence struct, atomically with its stake. The identity is the HMAC pseudonym of the Duolingo
 * profile, never the raw id.
 */
export async function buildBaselineAttestation(
  input:
    | { account: Hex; profileId: string; configHash: Hex; intent: "create"; createNonce: Hex; now?: number }
    | { account: Hex; profileId: string; configHash: Hex; intent: "join"; pactId: bigint; now?: number },
  environment: Record<string, string | undefined> = process.env,
): Promise<BaselineAttestation> {
  const verifyingContract = escrowVerifyingContract(environment);
  const identityHash = duolingoIdentityHash(input.profileId);
  const nul = input.intent === "create"
    ? escrowBaselineNullifier({ identityHash, intent: "create", createNonce: input.createNonce })
    : escrowBaselineNullifier({ identityHash, intent: "join", pactId: input.pactId });
  const { issuedAt, expiresAt } = escrowAttestationWindow(input.now);
  const message: BaselineMessage = {
    account: getAddress(input.account),
    configHash: input.configHash,
    identityHash,
    nullifier: nul,
    issuedAt,
    expiresAt,
  };
  const signature = await signBaseline(message, verifyingContract);
  return { configHash: input.configHash, identityHash, nullifier: nul, issuedAt, expiresAt, signature };
}

/**
 * The complete final attestation: earnedXp is the delta the backend computed between the immutable baseline
 * and the final proof, occurredAt is the final proof's timestamp, and the contract checks earnedXp clears
 * the pact's target. Only called once the delta has been ruled sufficient.
 */
export async function buildFinalAttestation(
  input: {
    account: Hex;
    profileId: string;
    pactId: bigint;
    earnedXp: number;
    targetXp: number;
    occurredAt: number;
    now?: number;
  },
  environment: Record<string, string | undefined> = process.env,
): Promise<FinalAttestation> {
  const verifyingContract = escrowVerifyingContract(environment);
  const identityHash = duolingoIdentityHash(input.profileId);
  const nul = escrowFinalNullifier({ identityHash, pactId: input.pactId });
  const { issuedAt, expiresAt } = escrowAttestationWindow(input.now);
  const message: FinalMessage = {
    pactId: input.pactId,
    account: getAddress(input.account),
    identityHash,
    earnedXp: input.earnedXp,
    targetXp: input.targetXp,
    nullifier: nul,
    occurredAt: BigInt(input.occurredAt),
    issuedAt,
    expiresAt,
  };
  const signature = await signFinal(message, verifyingContract);
  return {
    identityHash,
    earnedXp: input.earnedXp,
    targetXp: input.targetXp,
    nullifier: nul,
    occurredAt: BigInt(input.occurredAt),
    issuedAt,
    expiresAt,
    signature,
  };
}

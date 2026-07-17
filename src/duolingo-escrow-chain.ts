import { getAddress, type Address, type Hex } from "viem";
import { lockInPublicClient } from "./chain";
import { escrowVerifyingContract } from "./duolingo-escrow-attestation";

/**
 * Reads LockInDuolingoEscrow (contract B) on-chain. A payout-authorising final attestation must take the
 * Lock's terms from the chain, never from the browser: the client sends only a pactId, and the backend
 * resolves the configHash, the participant's bound identity, the target and the window from the contract.
 */

const duoPactComponents = [
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

export const duolingoEscrowAbi = [
  { type: "function", name: "getPact", stateMutability: "view", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "tuple", components: duoPactComponents }] },
  { type: "function", name: "pactConfigHash", stateMutability: "view", inputs: [{ name: "pactId", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "joined", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "completed", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "participantIdentity", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "", type: "bytes32" }] },
] as const;

export type EscrowPactView = Readonly<{
  configHash: Hex;
  targetXp: number;
  startsAt: number;
  durationSeconds: number;
  participantCount: number;
  minParticipants: number;
  maxParticipants: number;
  finalized: boolean;
  cancelled: boolean;
  joined: boolean;
  completed: boolean;
  participantIdentity: Hex;
}>;

export class EscrowChainUnavailableError extends Error {
  constructor(message = "The Duolingo escrow could not be read on-chain") {
    super(message);
    this.name = "EscrowChainUnavailableError";
  }
}

/** The contract's SUBMISSION_GRACE_PERIOD: a final proof captured during the challenge may still be
 *  submitted up to an hour after it ends. */
export const SUBMISSION_GRACE_SECONDS = 60 * 60;

/**
 * Refuses a final the contract would already reject, so the backend never signs a doomed attestation nor
 * spends a Reclaim proof on a Lock that cannot be completed. `mode` distinguishes CAPTURING a fresh proof
 * (which must land inside the challenge, since its timestamp is now) from SUBMITTING one (allowed through
 * the grace period). The contract remains the ultimate guard; this only fails fast on readable state.
 */
export function assertEscrowFinalOpen(
  pact: EscrowPactView,
  mode: "capture" | "submit",
  nowSeconds = Math.floor(Date.now() / 1_000),
): void {
  if (!pact.joined) throw new Error("You are not a participant in this Lock");
  if (pact.completed) throw new Error("You have already completed this Lock");
  if (pact.cancelled || pact.finalized) throw new Error("That Lock is closed");
  if (pact.participantCount < pact.minParticipants) {
    throw new Error("This Lock did not fill, so it cannot be completed");
  }
  const endsAt = pact.startsAt + pact.durationSeconds;
  if (nowSeconds < pact.startsAt) throw new Error("This Lock has not started yet");
  const limit = mode === "capture" ? endsAt : endsAt + SUBMISSION_GRACE_SECONDS;
  if (nowSeconds >= limit) {
    throw new Error(mode === "capture" ? "The challenge window has ended" : "The submission window has closed");
  }
}

/**
 * The Lock's on-chain state for a given participant, as the final flow needs it: whether the wallet joined
 * and already completed, its bound identity, the target and the window. Returns null if the pact does not
 * exist. Throws EscrowChainUnavailableError if the chain cannot be reached, so the caller can offer a retry
 * rather than a rejection.
 */
export async function readEscrowPact(
  pactId: bigint,
  account: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<EscrowPactView | null> {
  const address = escrowVerifyingContract(environment);
  const wallet = getAddress(account) as Address;
  const client = lockInPublicClient();
  try {
    const [pact, isJoined, isCompleted, identity] = await Promise.all([
      client.readContract({ address, abi: duolingoEscrowAbi, functionName: "getPact", args: [pactId] }),
      client.readContract({ address, abi: duolingoEscrowAbi, functionName: "joined", args: [pactId, wallet] }),
      client.readContract({ address, abi: duolingoEscrowAbi, functionName: "completed", args: [pactId, wallet] }),
      client.readContract({ address, abi: duolingoEscrowAbi, functionName: "participantIdentity", args: [pactId, wallet] }),
    ]);
    if (getAddress(pact.creator) === "0x0000000000000000000000000000000000000000") return null;
    return {
      configHash: pact.configHash,
      targetXp: Number(pact.targetXp),
      startsAt: Number(pact.startsAt),
      durationSeconds: Number(pact.durationSeconds),
      participantCount: Number(pact.participantCount),
      minParticipants: Number(pact.minParticipants),
      maxParticipants: Number(pact.maxParticipants),
      finalized: pact.finalized,
      cancelled: pact.cancelled,
      joined: isJoined,
      completed: isCompleted,
      participantIdentity: identity,
    };
  } catch (error) {
    // A missing pact reverts PactNotFound; treat a decodable revert as "no such pact", a transport failure
    // as unavailable so the UI can retry rather than tell the athlete their Lock does not exist.
    if (error instanceof Error && /PactNotFound|reverted/i.test(error.message)) return null;
    throw new EscrowChainUnavailableError();
  }
}

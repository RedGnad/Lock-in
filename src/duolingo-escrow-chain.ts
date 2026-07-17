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

/**
 * The Lock's on-chain state for a given participant, as the final flow needs it: whether the wallet joined
 * and already completed, its bound identity, the target and the window. Returns null if the pact does not
 * exist. Throws EscrowChainUnavailableError if the chain cannot be reached, so the caller can offer a retry
 * rather than a rejection.
 */
export async function readEscrowPact(
  pactId: bigint,
  account: string,
  environment: NodeJS.ProcessEnv = process.env,
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

/** The pact's stored configHash alone, for binding a joiner's baseline to this exact Lock. */
export async function readEscrowPactConfigHash(
  pactId: bigint,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Hex | null> {
  const address = escrowVerifyingContract(environment);
  try {
    return await lockInPublicClient().readContract({
      address,
      abi: duolingoEscrowAbi,
      functionName: "pactConfigHash",
      args: [pactId],
    });
  } catch (error) {
    if (error instanceof Error && /PactNotFound|reverted/i.test(error.message)) return null;
    throw new EscrowChainUnavailableError();
  }
}

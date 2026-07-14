import { getAddress, isAddress, keccak256, stringToHex, type Address } from "viem";
import { escrowAddress, lockInPublicClient } from "./chain";
import { lockInAbi } from "./lock-in-abi";

export type OnchainPactPolicy = {
  walletAddress: Address;
  pactId: string;
  dayIndex: number;
  challenge: string;
  startsAtMs: number;
  endsAtMs: number;
  minDistanceMeters: number;
  claimDeadlineMs: number;
};

export async function loadOnchainPactPolicy(input: {
  walletAddress: string;
  pactId: string;
  dayIndex: number;
  challenge: string;
}): Promise<OnchainPactPolicy> {
  if (!escrowAddress) throw new Error("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS is not configured");
  if (!isAddress(input.walletAddress)) throw new Error("Invalid wallet address");
  if (!/^\d+$/.test(input.pactId)) throw new Error("Invalid pact ID");
  if (!Number.isSafeInteger(input.dayIndex) || input.dayIndex < 0 || input.dayIndex > 4) throw new Error("Invalid day index");
  const walletAddress = getAddress(input.walletAddress);
  const client = lockInPublicClient();
  const pactId = BigInt(input.pactId);
  const [pact, challenge, joined, bitmap] = await Promise.all([
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [pactId] }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pactChallenges", args: [pactId] }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "joined", args: [pactId, walletAddress] }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "completionBitmap", args: [pactId, walletAddress] }),
  ]);
  const [creator, startsAt, claimDeadline, , minDistanceMeters, , , , daysRequired, challengeHash, , , finalized, cancelled] = pact;
  if (creator === "0x0000000000000000000000000000000000000000") throw new Error("Pact not found");
  if (finalized || cancelled) throw new Error("Pact is closed");
  if (!joined) throw new Error("Wallet has not joined this pact");
  if (input.dayIndex >= daysRequired) throw new Error("Day is outside this pact");
  if ((bitmap & (1 << input.dayIndex)) !== 0) throw new Error("This day is already proved");
  if (challenge !== input.challenge || keccak256(stringToHex(input.challenge)) !== challengeHash) {
    throw new Error("Challenge does not match the onchain pact");
  }
  if (Date.now() > Number(claimDeadline) * 1_000) throw new Error("Claim deadline has passed");
  const startsAtMs = (Number(startsAt) + input.dayIndex * 86_400) * 1_000;
  return {
    walletAddress,
    pactId: input.pactId,
    dayIndex: input.dayIndex,
    challenge,
    startsAtMs,
    endsAtMs: startsAtMs + 86_400_000,
    minDistanceMeters,
    claimDeadlineMs: Number(claimDeadline) * 1_000,
  };
}

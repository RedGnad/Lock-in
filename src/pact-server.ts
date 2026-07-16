import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { escrowAddress, lockInPublicClient } from "./chain";
import { lockInAbi, STRAVA_RUN_MISSION, type PactTuple } from "./lock-in-abi";

const SUBMISSION_GRACE_MS = 24 * 60 * 60 * 1_000;

/** Strava uploads late, so a finished day stays submittable for the grace window the escrow enforces. */
export function proofSubmissionDeadlineMs(missionType: number, endsAtMs: number): number {
  return missionType === STRAVA_RUN_MISSION ? endsAtMs + SUBMISSION_GRACE_MS : endsAtMs;
}

export type ProofPolicy = {
  walletAddress: Address;
  pactId: string;
  missionType: 1;
  phase: "completion";
  intent?: "create" | "join";
  dayIndex?: number;
  dailyTarget: number;
  startsAtMs: number;
  endsAtMs: number;
};

function validPactId(value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) throw new Error("Invalid pact ID");
  return BigInt(value);
}

export async function loadProofPolicy(input: {
  walletAddress: string;
  pactId: string;
  phase: "completion";
  intent?: "create" | "join";
  dayIndex?: number;
  missionType?: number;
}): Promise<ProofPolicy> {
  if (!escrowAddress) throw new Error("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS is not configured");
  if (!isAddress(input.walletAddress)) throw new Error("Invalid wallet address");
  const walletAddress = getAddress(input.walletAddress);
  const client = lockInPublicClient();

  const pactId = validPactId(input.pactId);
  const block = await client.getBlock({ blockTag: "latest" });
  const atBlock = { blockNumber: block.number } as const;

  const [pact, joined, bitmap, completed] = await Promise.all([
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [pactId], ...atBlock }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "joined", args: [pactId, walletAddress], ...atBlock }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "completionBitmap", args: [pactId, walletAddress], ...atBlock }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "completionCount", args: [pactId, walletAddress], ...atBlock }),
  ]);
  const typedPact = pact as PactTuple;
  if (typedPact[0] === zeroAddress) throw new Error("Pact not found");
  if (typedPact[15] || typedPact[16]) throw new Error("Pact is closed");
  if (typedPact[11] !== STRAVA_RUN_MISSION) throw new Error("Unsupported mission");
  const chainNowMs = Number(block.timestamp) * 1_000;

  if (!joined) throw new Error("Wallet has not joined this pact");
  if (typedPact[4] < typedPact[9]) throw new Error("This pact did not reach its minimum crew");
  if (completed >= typedPact[8]) throw new Error("The completion target is already met");
  if (!Number.isSafeInteger(input.dayIndex) || Number(input.dayIndex) < 0 || Number(input.dayIndex) >= typedPact[7]) {
    throw new Error("Invalid pact day");
  }
  const dayIndex = Number(input.dayIndex);
  if ((BigInt(bitmap) & (1n << BigInt(dayIndex))) !== 0n) throw new Error("This day is already verified");
  const startsAtMs = (Number(typedPact[1]) + dayIndex * 86_400) * 1_000;
  const endsAtMs = startsAtMs + 86_400_000;
  if (
    chainNowMs < startsAtMs
      || chainNowMs >= proofSubmissionDeadlineMs(typedPact[11] as 1 | 2, endsAtMs)
  ) {
    throw new Error("This pact day is not open");
  }
  return {
    walletAddress,
    pactId: pactId.toString(),
    missionType: STRAVA_RUN_MISSION,
    phase: "completion",
    dayIndex,
    dailyTarget: typedPact[3],
    startsAtMs,
    endsAtMs,
  };
}

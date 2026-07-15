import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { escrowAddress, lockInPublicClient } from "./chain";
import { DUOLINGO_XP_MISSION, lockInAbi, STRAVA_RUN_MISSION, type PactTuple } from "./lock-in-abi";
import { duolingoOwnershipCode } from "./duolingo-proof-policy";
import { stravaActivityCode } from "./pact-code";

export type ProofPolicyV5 = {
  walletAddress: Address;
  pactId: string;
  missionType: 1 | 2;
  phase: "baseline" | "completion";
  intent?: "create" | "join";
  dayIndex?: number;
  ownershipCode?: string;
  proofCode?: string;
  dailyTarget: number;
  startsAtMs: number;
  endsAtMs: number;
};

function validPactId(value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) throw new Error("Invalid pact ID");
  return BigInt(value);
}

export async function loadProofPolicyV5(input: {
  walletAddress: string;
  pactId: string;
  phase: "baseline" | "completion";
  intent?: "create" | "join";
  dayIndex?: number;
  missionType?: number;
}): Promise<ProofPolicyV5> {
  if (!escrowAddress) throw new Error("NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS is not configured");
  if (!isAddress(input.walletAddress)) throw new Error("Invalid wallet address");
  const walletAddress = getAddress(input.walletAddress);
  const client = lockInPublicClient();

  if (input.phase === "baseline" && input.intent === "create") {
    if (input.missionType !== DUOLINGO_XP_MISSION) throw new Error("Creation baseline is only available for Duolingo");
    if (input.pactId !== "0") throw new Error("Creation baseline must use the create sentinel");
    const block = await client.getBlock({ blockTag: "latest" });
    const nowMs = Number(block.timestamp) * 1_000;
    return {
      walletAddress,
      pactId: "0",
      missionType: DUOLINGO_XP_MISSION,
      phase: "baseline",
      intent: "create",
      ownershipCode: duolingoOwnershipCode(walletAddress),
      dailyTarget: 1,
      startsAtMs: nowMs - 10 * 60_000,
      endsAtMs: nowMs + 20 * 60_000,
    };
  }

  const pactId = validPactId(input.pactId);

  const [pact, joined, bitmap, completed, block] = await Promise.all([
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "pacts", args: [pactId] }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "joined", args: [pactId, walletAddress] }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "completionBitmap", args: [pactId, walletAddress] }),
    client.readContract({ address: escrowAddress, abi: lockInAbi, functionName: "completionCount", args: [pactId, walletAddress] }),
    client.getBlock({ blockTag: "latest" }),
  ]);
  const typedPact = pact as PactTuple;
  if (typedPact[0] === zeroAddress) throw new Error("Pact not found");
  if (typedPact[13] || typedPact[14]) throw new Error("Pact is closed");
  if (typedPact[10] !== STRAVA_RUN_MISSION && typedPact[10] !== DUOLINGO_XP_MISSION) {
    throw new Error("Unsupported mission");
  }
  const chainNowMs = Number(block.timestamp) * 1_000;

  if (input.phase === "baseline") {
    if (input.intent !== "join" || typedPact[10] !== DUOLINGO_XP_MISSION) {
      throw new Error("This pact does not accept a Duolingo baseline");
    }
    if (joined) throw new Error("Wallet already joined this pact");
    if (chainNowMs >= Number(typedPact[1]) * 1_000) throw new Error("Registration is closed");
    return {
      walletAddress,
      pactId: pactId.toString(),
      missionType: DUOLINGO_XP_MISSION,
      phase: "baseline",
      intent: "join",
      ownershipCode: duolingoOwnershipCode(walletAddress),
      dailyTarget: typedPact[3],
      startsAtMs: chainNowMs - 10 * 60_000,
      endsAtMs: Number(typedPact[1]) * 1_000,
    };
  }

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
  if (chainNowMs < startsAtMs || chainNowMs >= endsAtMs) throw new Error("This pact day is not open");

  return {
    walletAddress,
    pactId: pactId.toString(),
    missionType: typedPact[10] as 1 | 2,
    phase: "completion",
    dayIndex,
    ownershipCode: typedPact[10] === DUOLINGO_XP_MISSION ? duolingoOwnershipCode(walletAddress) : undefined,
    proofCode: typedPact[10] === STRAVA_RUN_MISSION ? stravaActivityCode(pactId.toString(), walletAddress, dayIndex) : undefined,
    dailyTarget: typedPact[3],
    startsAtMs,
    endsAtMs,
  };
}

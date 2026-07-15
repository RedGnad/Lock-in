import { encodePacked, getAddress, keccak256, type Address } from "viem";

export const STRAVA_PACT_CHALLENGE_PATTERN = /^LI-[A-Z0-9]{16,28}$/;
export const STRAVA_DAILY_PROOF_CODE_PATTERN = /^LI-[A-Z0-9]{16,28}D(?:0[1-9]|[12][0-9]|30)$/;

export function dailyProofCode(pactChallenge: string, dayIndex: number): string {
  if (!STRAVA_PACT_CHALLENGE_PATTERN.test(pactChallenge)) {
    throw new Error("Invalid Strava lock challenge");
  }
  if (!Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayIndex > 29) {
    throw new Error("Invalid Strava lock day");
  }
  return `${pactChallenge}D${String(dayIndex + 1).padStart(2, "0")}`;
}

export function stravaActivityCode(pactId: string, walletAddress: Address, dayIndex: number): string {
  if (!/^[1-9][0-9]*$/.test(pactId) || !Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayIndex > 29) {
    throw new Error("Invalid Strava lock code input");
  }
  const challenge = keccak256(encodePacked(
    ["uint256", "address"],
    [BigInt(pactId), getAddress(walletAddress)],
  )).slice(2, 18).toUpperCase();
  return `LI-${challenge}D${String(dayIndex + 1).padStart(2, "0")}`;
}

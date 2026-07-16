import { NextResponse } from "next/server";
import type { Address, PublicClient } from "viem";
import { escrowAddress, escrowDeploymentBlock, lockInPublicClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";
import {
  buildSocialLeaderboards,
  type MissionDayScoreEvent,
  type PlayerHandleEvent,
  type PlayerVisibilityEvent,
  type ScoreDayEvent,
} from "@/src/social-score";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 15_000;
/**
 * Monad's public RPCs cap eth_getLogs by BLOCK RANGE, and the caps are small on purpose: a block lands
 * every 400ms and carries far more than an Ethereum block. QuickNode's rpc.monad.xyz allows 100 and
 * answers HTTP 413 above it; Alchemy's rpc1.monad.xyz allows 1,000 blocks or 10,000 logs, whichever binds
 * first. https://docs.monad.xyz/reference/rpc-limits
 *
 * 1,000 is the documented ceiling of the endpoint we point at. Raising it past what the provider allows
 * does not fail loudly, it fails as a 413 that this route turns into a 503.
 */
const FALLBACK_BLOCK_RANGE = 1_000n;
const successHeaders = { "Cache-Control": "public, s-maxage=15, must-revalidate" };
const failureHeaders = { "Cache-Control": "no-store", "Retry-After": "15" };

type EventData = {
  scoreEvents: ScoreDayEvent[];
  missionEvents: MissionDayScoreEvent[];
  handleEvents: PlayerHandleEvent[];
  visibilityEvents: PlayerVisibilityEvent[];
};

type LeaderboardResponse = ReturnType<typeof buildSocialLeaderboards> & {
  ok: true;
  generatedAt: string;
  throughBlock: string;
};

let cached: { address: Address; expiresAt: number; data: LeaderboardResponse } | null = null;
let inFlight: Promise<LeaderboardResponse> | null = null;

function mergeEvents(target: EventData, source: EventData) {
  target.scoreEvents.push(...source.scoreEvents);
  target.missionEvents.push(...source.missionEvents);
  target.handleEvents.push(...source.handleEvents);
  target.visibilityEvents.push(...source.visibilityEvents);
}

async function readEventRange(client: PublicClient, address: Address, fromBlock: bigint, toBlock: bigint): Promise<EventData> {
  const [scoreLogs, missionLogs, handleLogs, visibilityLogs] = await Promise.all([
    client.getContractEvents({ address, abi: lockInAbi, eventName: "LockScoreAwarded", fromBlock, toBlock }),
    client.getContractEvents({ address, abi: lockInAbi, eventName: "MissionDayVerified", fromBlock, toBlock }),
    client.getContractEvents({ address, abi: lockInAbi, eventName: "PlayerHandleSet", fromBlock, toBlock }),
    client.getContractEvents({ address, abi: lockInAbi, eventName: "PlayerProfileVisibilityUpdated", fromBlock, toBlock }),
  ]);

  return {
    scoreEvents: scoreLogs.flatMap(({ args }) => args.account && args.utcDay !== undefined
      ? [{ account: args.account, utcDay: args.utcDay }]
      : []),
    missionEvents: missionLogs.flatMap(({ args }) => args.account && args.utcDay !== undefined && args.missionType !== undefined
      ? [{ account: args.account, utcDay: args.utcDay, missionType: args.missionType }]
      : []),
    handleEvents: handleLogs.flatMap(({ args }) => args.account && args.handle !== undefined
      ? [{ account: args.account, handle: args.handle }]
      : []),
    visibilityEvents: visibilityLogs.flatMap(({ args }) => args.account && args.hidden !== undefined
      ? [{ account: args.account, hidden: args.hidden }]
      : []),
  };
}

async function readAllEvents(client: PublicClient, address: Address, latestBlock: bigint) {
  const empty: EventData = { scoreEvents: [], missionEvents: [], handleEvents: [], visibilityEvents: [] };
  if (escrowDeploymentBlock > latestBlock) return empty;

  try {
    return await readEventRange(client, address, escrowDeploymentBlock, latestBlock);
  } catch (fullRangeError) {
    if (latestBlock - escrowDeploymentBlock < FALLBACK_BLOCK_RANGE) throw fullRangeError;
    for (let fromBlock = escrowDeploymentBlock; fromBlock <= latestBlock; fromBlock += FALLBACK_BLOCK_RANGE) {
      const toBlock = fromBlock + FALLBACK_BLOCK_RANGE - 1n > latestBlock
        ? latestBlock
        : fromBlock + FALLBACK_BLOCK_RANGE - 1n;
      mergeEvents(empty, await readEventRange(client, address, fromBlock, toBlock));
    }
    return empty;
  }
}

async function loadLeaderboard(address: Address): Promise<LeaderboardResponse> {
  const client = lockInPublicClient();
  const latestBlock = await client.getBlockNumber();
  const events = await readAllEvents(client, address, latestBlock);
  return {
    ok: true,
    ...buildSocialLeaderboards(events),
    generatedAt: new Date().toISOString(),
    throughBlock: latestBlock.toString(),
  };
}

export async function GET() {
  if (!escrowAddress) {
    return NextResponse.json({ ok: false, error: "Leaderboard is not configured yet." }, { status: 503, headers: failureHeaders });
  }

  if (cached && cached.address.toLowerCase() === escrowAddress.toLowerCase() && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.data, { headers: successHeaders });
  }

  try {
    inFlight ||= loadLeaderboard(escrowAddress);
    const data = await inFlight;
    cached = { address: escrowAddress, expiresAt: Date.now() + CACHE_TTL_MS, data };
    return NextResponse.json(data, { headers: successHeaders });
  } catch {
    return NextResponse.json({ ok: false, error: "The onchain leaderboard is temporarily unavailable." }, { status: 503, headers: failureHeaders });
  } finally {
    inFlight = null;
  }
}

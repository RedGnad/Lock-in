import { NextResponse } from "next/server";
import type { Address, PublicClient } from "viem";
import { duolingoEscrowAddress, duolingoEscrowDeploymentBlock, escrowAddress, escrowDeploymentBlock, lockInLogsClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";
import { lockInDuolingoAbi } from "@/src/lock-in-duolingo-abi";
import {
  buildSocialLeaderboards,
  type MissionDayScoreEvent,
  type PlayerHandleEvent,
  type PlayerVisibilityEvent,
  type ScoreDayEvent,
} from "@/src/social-score";

const SECONDS_PER_UTC_DAY = 86_400;

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
  completionEvents: ScoreDayEvent[];
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
  target.completionEvents.push(...source.completionEvents);
  target.handleEvents.push(...source.handleEvents);
  target.visibilityEvents.push(...source.visibilityEvents);
}

/**
 * Duolingo completions from escrow B, mapped to a verified UTC day. The day comes from the event's own
 * occurredAt (canonical, signed by the evidence signer), and only if that is absent from the log's block
 * timestamp. A client-supplied date is never trusted for scoring.
 */
async function readCompletionRange(client: PublicClient, address: Address, fromBlock: bigint, toBlock: bigint): Promise<ScoreDayEvent[]> {
  const logs = await client.getContractEvents({ address, abi: lockInDuolingoAbi, eventName: "CompletionVerified", fromBlock, toBlock });
  const events: ScoreDayEvent[] = [];
  for (const { args, blockNumber } of logs) {
    if (!args.account) continue;
    let seconds = args.occurredAt !== undefined ? Number(args.occurredAt) : 0;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      const block = await client.getBlock({ blockNumber });
      seconds = Number(block.timestamp);
    }
    events.push({ account: args.account, utcDay: Math.floor(seconds / SECONDS_PER_UTC_DAY) });
  }
  return events;
}

async function readAllCompletions(client: PublicClient, address: Address, latestBlock: bigint): Promise<ScoreDayEvent[]> {
  if (duolingoEscrowDeploymentBlock > latestBlock) return [];
  try {
    return await readCompletionRange(client, address, duolingoEscrowDeploymentBlock, latestBlock);
  } catch (fullRangeError) {
    if (latestBlock - duolingoEscrowDeploymentBlock < FALLBACK_BLOCK_RANGE) throw fullRangeError;
    const collected: ScoreDayEvent[] = [];
    for (let fromBlock = duolingoEscrowDeploymentBlock; fromBlock <= latestBlock; fromBlock += FALLBACK_BLOCK_RANGE) {
      const toBlock = fromBlock + FALLBACK_BLOCK_RANGE - 1n > latestBlock ? latestBlock : fromBlock + FALLBACK_BLOCK_RANGE - 1n;
      collected.push(...await readCompletionRange(client, address, fromBlock, toBlock));
    }
    return collected;
  }
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
    completionEvents: [],
  };
}

async function readAllEvents(client: PublicClient, address: Address, latestBlock: bigint) {
  const empty: EventData = { scoreEvents: [], missionEvents: [], completionEvents: [], handleEvents: [], visibilityEvents: [] };
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
  // Logs, not state: this must use the endpoint chosen for its block-range cap, not the keyed one.
  const client = lockInLogsClient();
  const latestBlock = await client.getBlockNumber();
  const [events, completionEvents] = await Promise.all([
    readAllEvents(client, address, latestBlock),
    duolingoEscrowAddress ? readAllCompletions(client, duolingoEscrowAddress, latestBlock) : Promise.resolve([] as ScoreDayEvent[]),
  ]);
  events.completionEvents.push(...completionEvents);
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

import { NextResponse } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import { escrowAddress, escrowDeploymentBlock, lockInLogsClient } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";
import { readEventsInChunks } from "@/src/monad-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The crew of a Lock, read from logs on the server.
 *
 * The browser used to scan this itself, from the escrow's deployment block to latest. That is one request
 * per 1,000 blocks per event, so it was already 80 requests per page load and grows by ~216 round trips a
 * day at Monad's 400ms blocks. The public RPC refused it and the page said "crew details unavailable".
 *
 * Server-side the scan happens once per window and every viewer shares the answer, on the endpoint chosen
 * for its block-range cap rather than the keyed one whose free tier caps getLogs at 10 blocks.
 *
 * This is still a scan. It buys the canary, not a launch: the honest fix is an incremental cache that only
 * ever reads forward from the last block it saw.
 */

const CACHE_TTL_MS = 15_000;

type CrewResponse = {
  ok: true;
  members: Address[];
  highFives: { from: Address; to: Address; dayIndex: number }[];
  throughBlock: string;
};

const cache = new Map<string, { expiresAt: number; data: CrewResponse }>();
const inFlight = new Map<string, Promise<CrewResponse>>();

async function loadCrew(address: Address, pactId: bigint): Promise<CrewResponse> {
  const client = lockInLogsClient();
  const latestBlock = await client.getBlockNumber();
  const [joinLogs, highFiveLogs] = await Promise.all([
    readEventsInChunks(client, {
      address,
      abi: lockInAbi,
      eventName: "PactJoined",
      args: { pactId },
      fromBlock: escrowDeploymentBlock,
      toBlock: latestBlock,
    }) as Promise<{ args: { account?: Address } }[]>,
    readEventsInChunks(client, {
      address,
      abi: lockInAbi,
      eventName: "HighFiveSent",
      args: { pactId },
      fromBlock: escrowDeploymentBlock,
      toBlock: latestBlock,
    }) as Promise<{ args: { from?: Address; to?: Address; dayIndex?: number } }[]>,
  ]);

  return {
    ok: true,
    members: Array.from(new Set(joinLogs.flatMap(({ args }) => (args.account ? [args.account] : [])))),
    highFives: highFiveLogs.flatMap(({ args }) =>
      args.from && args.to && args.dayIndex !== undefined
        ? [{ from: args.from, to: args.to, dayIndex: Number(args.dayIndex) }]
        : []),
    throughBlock: latestBlock.toString(),
  };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!escrowAddress || !isAddress(escrowAddress) || !/^\d+$/.test(id) || BigInt(id) <= 0n) {
    return NextResponse.json({ ok: false, error: "Unknown Lock." }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const escrow = getAddress(escrowAddress);
  const key = `${escrow.toLowerCase()}:${id}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json(hit.data, { headers: { "Cache-Control": "public, s-maxage=15, must-revalidate" } });
  }

  try {
    let pending = inFlight.get(key);
    if (!pending) {
      pending = loadCrew(escrow, BigInt(id));
      inFlight.set(key, pending);
    }
    const data = await pending;
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data });
    return NextResponse.json(data, { headers: { "Cache-Control": "public, s-maxage=15, must-revalidate" } });
  } catch {
    // The participant COUNT comes from contract state and is rendered whatever this returns, so a failure
    // here degrades the roster rather than the page.
    return NextResponse.json({ ok: false, error: "Crew details are temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    });
  } finally {
    inFlight.delete(key);
  }
}

import type { Abi, Address, PublicClient } from "viem";

/**
 * Reads contract events within Monad's RPC block-range caps.
 *
 * Monad lands a block every 400ms, so its public RPCs cap eth_getLogs by block range rather than by
 * result size: QuickNode's rpc.monad.xyz allows 100 blocks and answers HTTP 413 above it, Alchemy's
 * rpc1.monad.xyz allows 1,000 blocks or 10,000 logs, whichever binds first.
 * https://docs.monad.xyz/reference/rpc-limits
 *
 * A single fromBlock->latest scan therefore stops working a few minutes after deployment, silently, as a
 * 413 the UI shows as an empty list. Everything that reads history must page.
 *
 * This paging is a stopgap, not a design. 400ms blocks are ~216,000 blocks a day, so the number of round
 * trips grows every day this escrow stays live and no chunk size fixes that. Before any real launch these
 * reads belong behind an indexer, or behind an incremental cache that stores events once and only ever
 * scans forward from the last block it saw.
 */
export const MONAD_LOG_BLOCK_RANGE = 1_000n;

export async function readEventsInChunks<const TAbi extends Abi>(
  client: PublicClient,
  input: {
    address: Address;
    abi: TAbi;
    eventName: string;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  },
): Promise<unknown[]> {
  // Ask for the whole range first. The documented block caps are not the only limit and often not the
  // binding one: rpc1.monad.xyz served 41,596 blocks in one call because the result was a single log,
  // while the same range split into 40 sequential calls was rate-limited and failed outright. Paging is
  // the fallback for ranges that are genuinely too big, not the default.
  try {
    return [...await client.getContractEvents({
      address: input.address,
      abi: input.abi,
      eventName: input.eventName,
      args: input.args,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    } as never)];
  } catch {
    // Fall through to paging.
  }

  const logs: unknown[] = [];
  for (let from = input.fromBlock; from <= input.toBlock; from += MONAD_LOG_BLOCK_RANGE) {
    const to = from + MONAD_LOG_BLOCK_RANGE - 1n > input.toBlock ? input.toBlock : from + MONAD_LOG_BLOCK_RANGE - 1n;
    const chunk = await client.getContractEvents({
      address: input.address,
      abi: input.abi,
      eventName: input.eventName,
      args: input.args,
      fromBlock: from,
      toBlock: to,
    } as never);
    logs.push(...chunk);
  }
  return logs;
}

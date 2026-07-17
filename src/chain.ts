import { createPublicClient, defineChain, http, type Address } from "viem";

export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://monadscan.com" },
  },
});

export const escrowAddress = process.env.NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS as Address | undefined;
/**
 * The Duolingo escrow (contract B). Absent until B is deployed and pinned: while it is unset the financial
 * flow stays inert and the Duolingo page shows the Live Proof Beta with the stake selector disabled.
 */
export const duolingoEscrowAddress = process.env.NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS as Address | undefined;
/**
 * The block the CURRENT escrow was deployed in, per deployments/monad-mainnet-oauth.json.
 *
 * Every log scan starts here. Leaving it on a previous escrow's block does not just waste requests: it
 * widens the range by hundreds of thousands of blocks, the public RPC answers 413, and the leaderboard
 * falls back to scanning 10k at a time until the route times out. Redeploying the escrow means changing
 * this line in the same commit.
 */
export const escrowDeploymentBlock = 88_203_155n;

export function lockInPublicClient() {
  return createPublicClient({
    chain: monad,
    transport: http(process.env.MONAD_RPC_URL || process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://rpc.monad.xyz"),
  });
}

/**
 * A client for reading LOGS, which is a different problem from reading state.
 *
 * Every provider caps eth_getLogs by block range, and the cap does not track how good the plan is:
 * Alchemy's free tier allows 10 blocks, QuickNode's public rpc.monad.xyz allows 100, Alchemy's public
 * rpc1.monad.xyz allows 1,000. So the keyed endpoint that serves state reads perfectly is the worst one
 * for history, and pointing both at the same URL means losing either health or the leaderboard.
 *
 * MONAD_LOGS_RPC_URL therefore routes log scans separately. It must stay on chain 143, and
 * MONAD_LOG_BLOCK_RANGE in src/monad-logs.ts must not exceed whatever it points at.
 */
export function lockInLogsClient() {
  return createPublicClient({
    chain: monad,
    transport: http(process.env.MONAD_LOGS_RPC_URL || "https://rpc1.monad.xyz"),
  });
}

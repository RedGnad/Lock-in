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

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

export function lockInPublicClient() {
  return createPublicClient({
    chain: monad,
    transport: http(process.env.MONAD_RPC_URL || process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://rpc.monad.xyz"),
  });
}

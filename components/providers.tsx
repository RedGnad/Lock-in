"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import { useState, type ReactNode } from "react";
import { monad } from "@/src/chain";

const config = createConfig({
  chains: [monad],
  connectors: [
    injected({ target: "phantom" }),
    injected({ target: "metaMask" }),
  ],
  multiInjectedProviderDiscovery: false,
  transports: { [monad.id]: http(monad.rpcUrls.default.http[0]) },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

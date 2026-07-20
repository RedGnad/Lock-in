"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, http, WagmiProvider } from "wagmi";
import { useEffect, useState, type ReactNode } from "react";
import { monad } from "@/src/chain";
import {
  browserWalletConnectors,
  type Eip6963ProviderDetail,
} from "@/src/wallet-connectors";

const EIP6963_DISCOVERY_MS = 350;

function walletConfig(
  providers: readonly Eip6963ProviderDetail[] = [],
  legacyProvider?: unknown,
) {
  return createConfig({
    chains: [monad],
    multiInjectedProviderDiscovery: false,
    connectors: browserWalletConnectors(providers, legacyProvider),
    transports: {
      [monad.id]: http(monad.rpcUrls.default.http[0]),
    },
    ssr: true,
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [config, setConfig] = useState(() => walletConfig());

  useEffect(() => {
    const discovered: Eip6963ProviderDetail[] = [];
    let settled = false;

    function announce(event: Event) {
      if (settled) return;
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (detail?.info?.rdns && detail.provider) discovered.push(detail);
    }

    function finishDiscovery() {
      if (settled) return;
      settled = true;
      window.removeEventListener("eip6963:announceProvider", announce);
      const legacyProvider = discovered.length === 0
        ? (window as Window & { ethereum?: unknown }).ethereum
        : undefined;
      setConfig(walletConfig(discovered, legacyProvider));
    }

    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const timeout = window.setTimeout(finishDiscovery, EIP6963_DISCOVERY_MS);
    const initialized = () => finishDiscovery();
    window.addEventListener("ethereum#initialized", initialized, { once: true });

    return () => {
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("eip6963:announceProvider", announce);
      window.removeEventListener("ethereum#initialized", initialized);
    };
  }, []);

  return (
    <WagmiProvider
      config={config}
      reconnectOnMount={false}
    >
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

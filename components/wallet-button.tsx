"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { monad } from "@/src/chain";

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected || !address) {
    return (
      <button className="wallet-button" onClick={() => connect({ connector: connectors[0] })} disabled={isPending}>
        {isPending ? "Connexion…" : "Connecter le wallet"}
      </button>
    );
  }
  if (chainId !== monad.id) {
    return <button className="wallet-button warning" onClick={() => switchChain({ chainId: monad.id })}>Passer sur Monad</button>;
  }
  return <button className="wallet-button connected" onClick={() => disconnect()}>{short(address)}</button>;
}

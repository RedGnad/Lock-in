"use client";

import { useEffect, useRef, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  if (!isConnected || !address) {
    return (
      <button className="wallet-button" onClick={() => connectors[0] && connect({ connector: connectors[0] })} disabled={isPending || !connectors[0]}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }
  if (chainId !== monad.id) {
    return <button className="wallet-button warning" onClick={() => switchChain({ chainId: monad.id })}>Switch to Monad</button>;
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(address!);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <div className="wallet-control" ref={root}>
      <button className="wallet-button connected" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu">{short(address)} <span>⌄</span></button>
      {open && <div className="wallet-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => void copyAddress()}>{copied ? "COPIED ✓" : "COPY ADDRESS"}</button>
        <a role="menuitem" href={`https://monadscan.com/address/${address}`} target="_blank" rel="noreferrer">VIEW ON MONADSCAN ↗</a>
        <button type="button" role="menuitem" onClick={() => { setOpen(false); disconnect(); }}>DISCONNECT</button>
      </div>}
    </div>
  );
}

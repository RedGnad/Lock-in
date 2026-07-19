"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { monad } from "@/src/chain";

const supportedConnectorIds = new Set(["phantom", "metaMask", "injected"]);

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function phantomBrowseUrl(currentUrl: string): string {
  const url = new URL(currentUrl);
  return `https://phantom.app/ul/browse/${encodeURIComponent(url.href)}?ref=${encodeURIComponent(url.origin)}`;
}

function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|IEMobile|Mobile/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function walletLabel(id: string, name: string): string {
  if (id === "phantom") return "Phantom";
  if (id === "metaMask") return "MetaMask";
  return name === "Injected" ? "Browser wallet" : name;
}

function walletMark(id: string): string {
  if (id === "phantom") return "P";
  if (id === "metaMask") return "M";
  return "W";
}

function connectionMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel/i.test(message)) return "Connection cancelled in your wallet.";
  if (/provider|not found|unavailable/i.test(message)) return "That wallet is no longer available in this browser.";
  return "Could not connect. Check your wallet and try again.";
}

// Same shape as connectionMessage: the wallet either declined the switch/add, or it cannot do it
// programmatically at all. wagmi adds Monad automatically (wallet_addEthereumChain) from the chain metadata
// when the wallet does not know chain 143, so the athlete never has to paste an RPC by hand.
function switchMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel|4001|request.*rejected/i.test(message)) {
    return "Network change cancelled. Switch to Monad to continue.";
  }
  return "Your wallet could not switch networks automatically. Open Monad in your wallet, then try again.";
}

export function WalletButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching, error: switchError, reset: resetSwitchError } = useSwitchChain();
  const [menuOpen, setMenuOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [availableConnectorUids, setAvailableConnectorUids] = useState<readonly string[]>([]);
  const [walletScanDone, setWalletScanDone] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const connectBusyRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const connectTrigger = useRef<HTMLButtonElement>(null);
  const connectDialog = useRef<HTMLDivElement>(null);

  const availableConnectors = useMemo(() => {
    const detected = connectors.filter((connector) => (
      supportedConnectorIds.has(connector.id) && availableConnectorUids.includes(connector.uid)
    ));
    const named = detected.filter((connector) => connector.id !== "injected");
    return named.length > 0 ? named : detected;
  }, [availableConnectorUids, connectors]);

  // Once a wallet is actually connected, release the lock and close the chooser for good. Never re-open it
  // or re-call connectAsync on our own: any further connect must be a deliberate user click.
  useEffect(() => {
    if (!isConnected || !address) return;
    connectBusyRef.current = false;
    setConnecting(false);
    setConnectOpen(false);
    setConnectionError("");
  }, [isConnected, address]);

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
    if (!connectOpen) return;
    let cancelled = false;
    let scanNumber = 0;

    async function scanWallets() {
      const currentScan = ++scanNumber;
      const configuredConnectors = connectors.filter((connector) => supportedConnectorIds.has(connector.id));
      const results = await Promise.all(configuredConnectors.map(async (connector) => {
        try {
          return await connector.getProvider() ? connector.uid : null;
        } catch {
          return null;
        }
      }));
      if (cancelled || currentScan !== scanNumber) return;
      setAvailableConnectorUids(results.filter((uid): uid is string => Boolean(uid)));
      setWalletScanDone(true);
    }

    setWalletScanDone(false);
    setAvailableConnectorUids([]);
    setConnectionError("");
    void scanWallets();
    const retry = window.setTimeout(() => void scanWallets(), 500);
    const initialized = () => void scanWallets();
    window.addEventListener("ethereum#initialized", initialized, { once: true });
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      window.removeEventListener("ethereum#initialized", initialized);
    };
  }, [connectOpen, connectors]);

  useEffect(() => {
    if (!connectOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyWasLocked = document.body.classList.contains("dialog-open");
    if (!bodyWasLocked) document.body.classList.add("dialog-open");
    const focusFrame = window.requestAnimationFrame(() => {
      connectDialog.current?.querySelector<HTMLElement>("button:not(:disabled), a[href]")?.focus();
    });

    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setConnectOpen(false);
        return;
      }
      if (event.key !== "Tab" || !connectDialog.current) return;
      const focusable = Array.from(connectDialog.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keydown);
      if (!bodyWasLocked) document.body.classList.remove("dialog-open");
      previouslyFocused?.focus();
    };
  }, [connectOpen]);

  function openWalletChooser() {
    if (connectBusyRef.current || connecting || isPending) return;
    setConnectionError("");
    setMenuOpen(false);
    setConnectOpen(true);
  }

  async function connectWallet(connector: (typeof connectors)[number]) {
    // Synchronous lock BEFORE any await or React rerender: two clicks that arrive in the same tick would
    // otherwise both fire connectAsync (two eth_requestAccounts, two native popups). A disabled attribute is
    // not enough because it only takes effect on the next render.
    if (connectBusyRef.current) return;
    connectBusyRef.current = true;
    setConnecting(true);
    setConnectionError("");
    // Close the chooser immediately so a stale dialog cannot be clicked again.
    setConnectOpen(false);

    try {
      // Connect only. Do NOT fold a chain switch into connect: passing chainId makes wagmi try to switch
      // (or add) Monad right after approval and can fire a second wallet prompt. The "Switch to Monad" button
      // handles the network afterwards if needed.
      await connectAsync({ connector });
    } catch (error) {
      setConnectionError(connectionMessage(error));
    } finally {
      connectBusyRef.current = false;
      setConnecting(false);
    }
  }

  async function switchToMonad() {
    resetSwitchError();
    try {
      // wagmi switches to chain 143, or asks the wallet to add Monad first if it does not know it. The
      // wallet shows its own native confirmation; nothing changes networks without the athlete's approval.
      await switchChainAsync({ chainId: monad.id });
    } catch {
      // Rendered from switchError below; a rejection is not fatal, the athlete stays connected.
    }
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(address!);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  const mobile = connectOpen && isMobileBrowser();
  const phantomUrl = connectOpen && typeof window !== "undefined" ? phantomBrowseUrl(window.location.href) : "";
  const chooser = connectOpen && typeof document !== "undefined" ? createPortal(
    <div
      className="wallet-connect-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setConnectOpen(false);
      }}
    >
      <div
        ref={connectDialog}
        className="wallet-connect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-connect-title"
        aria-describedby="wallet-connect-description"
      >
        <div className="wallet-connect-topline">
          <span>Monad · Self-custody</span>
          <button type="button" onClick={() => setConnectOpen(false)} aria-label="Close wallet chooser">×</button>
        </div>
        <h2 id="wallet-connect-title">Choose a wallet</h2>
        <p id="wallet-connect-description">Connect an installed wallet to sign your own transactions.</p>

        <div className="wallet-options" aria-live="polite">
          {availableConnectors.map((connector) => (
            <button
              type="button"
              className="wallet-option"
              data-wallet={connector.id}
              disabled={connecting || isPending || connectBusyRef.current}
              onClick={() => void connectWallet(connector)}
              key={connector.uid}
            >
              <span className="wallet-option-mark" aria-hidden="true">{walletMark(connector.id)}</span>
              <span className="wallet-option-copy">
                <strong>{connecting || isPending ? "Connecting…" : walletLabel(connector.id, connector.name)}</strong>
                <small>Detected in this browser</small>
              </span>
              <span className="wallet-option-arrow" aria-hidden="true">→</span>
            </button>
          ))}

          {!walletScanDone && <p className="wallet-connect-state">Looking for wallets…</p>}

          {walletScanDone && availableConnectors.length === 0 && mobile && phantomUrl && (
            <a className="wallet-option wallet-option-link" data-wallet="phantom" href={phantomUrl} rel="noreferrer">
              <span className="wallet-option-mark" aria-hidden="true">P</span>
              <span className="wallet-option-copy">
                <strong>Open in Phantom</strong>
                <small>Continue on this exact page</small>
              </span>
              <span className="wallet-option-arrow" aria-hidden="true">↗</span>
            </a>
          )}

          {walletScanDone && availableConnectors.length === 0 && !mobile && (
            <p className="wallet-connect-state">No browser wallet detected. Open Lock In in a wallet browser.</p>
          )}
        </div>

        {connectionError && <p className="wallet-connect-error" role="alert">{connectionError}</p>}
        <p className="wallet-connect-note">Nothing moves without your approval. Lock In never asks for a recovery phrase or private key.</p>
      </div>
    </div>,
    document.body,
  ) : null;

  if (!isConnected || !address) {
    return (
      <div className="wallet-control">
        <button
          ref={connectTrigger}
          className="wallet-button"
          type="button"
          disabled={connecting || isPending}
          onClick={openWalletChooser}
          aria-haspopup="dialog"
          aria-expanded={connectOpen}
        >
          {connecting || isPending ? "Connecting…" : "Connect wallet"}
        </button>
        {connectionError && !connectOpen && <p className="wallet-switch-note" role="alert">{connectionError}</p>}
        {chooser}
      </div>
    );
  }
  if (chainId !== monad.id) {
    return (
      <div className="wallet-control" ref={root}>
        <button className="wallet-button warning" type="button" disabled={isSwitching} onClick={() => void switchToMonad()}>
          {isSwitching ? "Check your wallet…" : "Switch to Monad"}
        </button>
        {switchError && <p className="wallet-switch-note" role="alert">{switchMessage(switchError)}</p>}
      </div>
    );
  }

  return (
    <div className="wallet-control" ref={root}>
      <button className="wallet-button connected" type="button" onClick={() => setMenuOpen((value) => !value)} aria-expanded={menuOpen} aria-haspopup="menu">{short(address)} <span>⌄</span></button>
      {menuOpen && <div className="wallet-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => void copyAddress()}>{copied ? "COPIED ✓" : "COPY ADDRESS"}</button>
        <a role="menuitem" href={`https://monadscan.com/address/${address}`} target="_blank" rel="noreferrer">VIEW ON MONADSCAN ↗</a>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); disconnect(); }}>DISCONNECT</button>
      </div>}
    </div>
  );
}

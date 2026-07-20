"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { monad } from "@/src/chain";
import { instrumentWalletProvider } from "@/src/wallet-request-diagnostics";

const CONNECT_TIMEOUT_MS = 45_000;
const LEGACY_INJECTED_CONNECTOR_ID = "injected";
const EIP6963_DISCOVERY_WAIT_MS = 450;

export type WalletConnectPhase = "idle" | "requesting" | "syncing" | "error";
export type WalletConnectEvent = "request" | "requestResolved" | "accountConfirmed" | "requestFailed" | "timeout" | "retry";

export function connectPhaseLocked(phase: WalletConnectPhase): boolean {
  return phase === "requesting" || phase === "syncing";
}

export function nextConnectPhase(phase: WalletConnectPhase, event: WalletConnectEvent): WalletConnectPhase {
  if (event === "accountConfirmed") return "idle";
  if (event === "requestFailed") return "error";
  if (event === "request") return connectPhaseLocked(phase) ? phase : "requesting";
  if (event === "requestResolved") return phase === "requesting" ? "syncing" : phase;
  if (event === "retry") return phase === "error" ? "idle" : phase;
  return phase;
}

export type BrowserWalletCandidate = {
  uid: string;
  id: string;
  name: string;
  provider: unknown;
  eip6963: boolean;
};

export type BrowserWalletKind = "metaMask" | "phantom" | "browser";

export function walletKind(id: string, name: string): BrowserWalletKind {
  const identity = `${id} ${name}`.toLowerCase();
  if (identity.includes("metamask")) return "metaMask";
  if (identity.includes("phantom")) return "phantom";
  return "browser";
}

function walletIdentity(candidate: BrowserWalletCandidate): string {
  const kind = walletKind(candidate.id, candidate.name);
  if (kind !== "browser") return kind;
  return candidate.id.trim().toLowerCase() || candidate.name.trim().toLowerCase();
}

function walletPriority(candidate: BrowserWalletCandidate): number {
  const kind = walletKind(candidate.id, candidate.name);
  if (kind === "metaMask") return 0;
  if (kind === "phantom") return 1;
  return 2;
}

/** Keeps EIP-6963 wallets when present; the one legacy provider is only eligible when none announced. */
export function selectInstalledWallets<T extends BrowserWalletCandidate>(candidates: readonly T[]): T[] {
  const eip6963 = candidates.filter((candidate) => candidate.eip6963);
  const source = eip6963.length > 0 ? eip6963 : candidates.filter((candidate) => !candidate.eip6963).slice(0, 1);
  const providers = new Set<unknown>();
  const identities = new Set<string>();
  const selected: T[] = [];

  for (const candidate of source) {
    const identity = walletIdentity(candidate);
    const providerIsReference = (typeof candidate.provider === "object" && candidate.provider !== null)
      || typeof candidate.provider === "function";
    if (identities.has(identity) || (providerIsReference && providers.has(candidate.provider))) continue;
    identities.add(identity);
    if (providerIsReference) providers.add(candidate.provider);
    selected.push(candidate);
  }

  return selected.sort((left, right) => (
    walletPriority(left) - walletPriority(right)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  ));
}

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
  const kind = walletKind(id, name);
  if (kind === "phantom") return "Phantom";
  if (kind === "metaMask") return "MetaMask";
  return name === "Injected" ? "Browser wallet" : name;
}

function walletMark(id: string, name: string): string {
  const kind = walletKind(id, name);
  if (kind === "phantom") return "P";
  if (kind === "metaMask") return "M";
  return "W";
}

function walletErrorDetails(error: unknown): { code?: number; message: string } {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  let code: number | undefined;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { cause?: unknown; code?: unknown; details?: unknown; message?: unknown; shortMessage?: unknown };
    if (code === undefined && typeof candidate.code === "number") code = candidate.code;
    for (const value of [candidate.shortMessage, candidate.details, candidate.message]) {
      if (typeof value === "string" && !messages.includes(value)) messages.push(value);
    }
    current = candidate.cause;
  }

  if (messages.length === 0) messages.push(String(error));
  return { code, message: messages.join(" ") };
}

export function connectionMessage(error: unknown): string {
  const { code, message } = walletErrorDetails(error);
  if (code === -32002 || /already (?:open|pending)|request.*(?:already|still).*pending|resource unavailable/i.test(message)) {
    return "A wallet request is already open. Complete or close it before trying again.";
  }
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
  const { address, chainId, isConnected, status: accountStatus } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching, error: switchError, reset: resetSwitchError } = useSwitchChain();
  const [menuOpen, setMenuOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [availableConnectorUids, setAvailableConnectorUids] = useState<readonly string[]>([]);
  const [walletScanDone, setWalletScanDone] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [connectPhase, setConnectPhase] = useState<WalletConnectPhase>("idle");
  const connectPhaseRef = useRef<WalletConnectPhase>("idle");
  const connectAttemptRef = useRef(0);
  const connectTimeoutRef = useRef<number | null>(null);
  const accountRef = useRef({ address, isConnected });
  const root = useRef<HTMLDivElement>(null);
  const connectTrigger = useRef<HTMLButtonElement>(null);
  const connectDialog = useRef<HTMLDivElement>(null);
  accountRef.current = { address, isConnected };

  const availableConnectors = useMemo(() => {
    const connectorsByUid = new Map(connectors.map((connector) => [connector.uid, connector]));
    return availableConnectorUids.flatMap((uid) => {
      const connector = connectorsByUid.get(uid);
      return connector ? [connector] : [];
    });
  }, [availableConnectorUids, connectors]);

  const updateConnectPhase = useCallback((phase: WalletConnectPhase) => {
    connectPhaseRef.current = phase;
    setConnectPhase(phase);
  }, []);

  const transitionConnectPhase = useCallback((event: WalletConnectEvent) => {
    const phase = nextConnectPhase(connectPhaseRef.current, event);
    updateConnectPhase(phase);
    return phase;
  }, [updateConnectPhase]);

  const finishConnectAttempt = useCallback((event: "accountConfirmed" | "requestFailed", attempt?: number) => {
    if (attempt !== undefined && attempt !== connectAttemptRef.current) return false;
    connectAttemptRef.current += 1;
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    transitionConnectPhase(event);
    return true;
  }, [transitionConnectPhase]);

  // Once a wallet is actually connected, release the lock and close the chooser for good. Never re-open it
  // or re-call connectAsync on our own: any further connect must be a deliberate user click.
  useEffect(() => {
    if (accountStatus !== "connected" || !isConnected || !address) return;
    finishConnectAttempt("accountConfirmed");
    setConnectOpen(false);
    setConnectionError("");
  }, [accountStatus, address, finishConnectAttempt, isConnected]);

  useEffect(() => () => {
    if (connectTimeoutRef.current !== null) window.clearTimeout(connectTimeoutRef.current);
  }, []);

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

    async function scanWallets(allowLegacyFallback: boolean) {
      const currentScan = ++scanNumber;
      const eip6963Connectors = connectors.filter((connector) => connector.id !== LEGACY_INJECTED_CONNECTOR_ID);
      const results = await Promise.all(eip6963Connectors.map(async (connector) => {
        try {
          const provider = await connector.getProvider();
          instrumentWalletProvider(provider, connector);
          return provider ? { connector, provider } : null;
        } catch {
          return null;
        }
      }));
      if (cancelled || currentScan !== scanNumber) return;
      const eip6963Candidates = results.flatMap((result) => result ? [{
        uid: result.connector.uid,
        id: result.connector.id,
        name: result.connector.name,
        provider: result.provider,
        eip6963: true,
      }] : []);
      let installed = selectInstalledWallets(eip6963Candidates);

      if (installed.length === 0 && allowLegacyFallback) {
        const fallback = connectors.find((connector) => connector.id === LEGACY_INJECTED_CONNECTOR_ID);
        if (fallback) {
          try {
            const provider = await fallback.getProvider();
            instrumentWalletProvider(provider, fallback);
            if (provider) installed = selectInstalledWallets([{
              uid: fallback.uid,
              id: fallback.id,
              name: fallback.name,
              provider,
              eip6963: false,
            }]);
          } catch {
            // A legacy provider can disappear while extensions initialize. The delayed scan will settle empty.
          }
        }
      }

      if (cancelled || currentScan !== scanNumber) return;
      setAvailableConnectorUids(installed.map((candidate) => candidate.uid));
      setWalletScanDone(installed.length > 0 || allowLegacyFallback);
    }

    setWalletScanDone(false);
    setAvailableConnectorUids([]);
    setConnectionError("");
    void scanWallets(false);
    const retry = window.setTimeout(() => void scanWallets(true), EIP6963_DISCOVERY_WAIT_MS);
    const initialized = () => void scanWallets(true);
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
        if (connectPhaseLocked(connectPhaseRef.current)) return;
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
    if (connectPhaseLocked(connectPhaseRef.current) || accountStatus === "reconnecting") return;
    transitionConnectPhase("retry");
    setConnectionError("");
    setMenuOpen(false);
    setConnectOpen(true);
  }

  async function connectWallet(connector: (typeof connectors)[number]) {
    // Synchronous lock BEFORE any await or React rerender: two clicks that arrive in the same tick would
    // otherwise both fire connectAsync (two eth_requestAccounts, two native popups). A disabled attribute is
    // not enough because it only takes effect on the next render.
    if (connectPhaseLocked(connectPhaseRef.current)) return;
    const attempt = connectAttemptRef.current + 1;
    connectAttemptRef.current = attempt;
    transitionConnectPhase("request");
    setConnectionError("");
    // Close the chooser immediately so a stale dialog cannot be clicked again.
    setConnectOpen(false);
    connectTimeoutRef.current = window.setTimeout(() => {
      if (attempt !== connectAttemptRef.current) return;
      if (accountRef.current.isConnected && accountRef.current.address) {
        finishConnectAttempt("accountConfirmed", attempt);
        setConnectionError("");
        return;
      }
      transitionConnectPhase("timeout");
      const message = connectPhaseRef.current === "syncing"
        ? "Wallet approved. Lock In is still syncing the connected account."
        : "The wallet request is still open. Complete or reject it in your wallet.";
      setConnectionError(message);
    }, CONNECT_TIMEOUT_MS);

    try {
      // Connect only. Do NOT fold a chain switch into connect: passing chainId makes wagmi try to switch
      // (or add) Monad right after approval and can fire a second wallet prompt. The "Switch to Monad" button
      // handles the network afterwards if needed.
      await connectAsync({ connector });
      if (attempt !== connectAttemptRef.current) return;
      transitionConnectPhase("requestResolved");
      setConnectionError("");
    } catch (error) {
      if (attempt !== connectAttemptRef.current) return;
      setConnectionError(connectionMessage(error));
      finishConnectAttempt("requestFailed", attempt);
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
  const connectLocked = connectPhaseLocked(connectPhase);
  const connectStatusLabel = connectPhase === "requesting" ? "Check your wallet…" : "Syncing wallet…";
  const recommendedConnectors = availableConnectors.filter((connector) => walletKind(connector.id, connector.name) !== "browser");
  const otherConnectors = availableConnectors.filter((connector) => walletKind(connector.id, connector.name) === "browser");
  const renderWalletOption = (connector: (typeof connectors)[number]) => {
    const icon = typeof connector.icon === "string" && connector.icon.startsWith("data:image/") ? connector.icon : "";
    return <button
      type="button"
      className="wallet-option"
      data-wallet={walletKind(connector.id, connector.name)}
      disabled={connectLocked}
      onClick={() => void connectWallet(connector)}
      key={connector.uid}
    >
      <span className="wallet-option-mark" aria-hidden="true">
        {icon ? <img src={icon} alt="" /> : walletMark(connector.id, connector.name)}
      </span>
      <span className="wallet-option-copy">
        <strong>{connectLocked ? connectStatusLabel : walletLabel(connector.id, connector.name)}</strong>
        <small>Detected in this browser</small>
      </span>
      <span className="wallet-option-arrow" aria-hidden="true">→</span>
    </button>;
  };
  const chooser = connectOpen && typeof document !== "undefined" ? createPortal(
    <div
      className="wallet-connect-backdrop"
      onMouseDown={(event) => {
        if (!connectLocked && event.target === event.currentTarget) setConnectOpen(false);
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
          <button type="button" disabled={connectLocked} onClick={() => setConnectOpen(false)} aria-label="Close wallet chooser">×</button>
        </div>
        <h2 id="wallet-connect-title">Choose a wallet</h2>
        <p id="wallet-connect-description">Connect an installed wallet to sign your own transactions.</p>

        <div className="wallet-options" aria-live="polite">
          {recommendedConnectors.length > 0 && <p className="wallet-options-label">Recommended</p>}
          {recommendedConnectors.map(renderWalletOption)}
          {otherConnectors.length > 0 && <p className="wallet-options-label">{recommendedConnectors.length > 0 ? "Other installed" : "Installed wallet"}</p>}
          {otherConnectors.map(renderWalletOption)}

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
      <div className="wallet-control" data-connect-phase={connectPhase} aria-busy={connectLocked}>
        <button
          ref={connectTrigger}
          className="wallet-button"
          type="button"
          disabled={connectLocked || accountStatus === "reconnecting"}
          onClick={openWalletChooser}
          aria-haspopup="dialog"
          aria-expanded={connectOpen}
        >
          {connectLocked ? connectStatusLabel : accountStatus === "reconnecting" ? "Syncing wallet…" : "Connect wallet"}
        </button>
        {connectionError && !connectOpen && <p className="wallet-switch-note" role="alert">{connectionError}</p>}
        {chooser}
      </div>
    );
  }
  if (chainId !== monad.id) {
    return (
      <div className="wallet-control" ref={root} data-connect-phase={connectPhase}>
        <button className="wallet-button warning" type="button" disabled={isSwitching} onClick={() => void switchToMonad()}>
          {isSwitching ? "Check your wallet…" : "Switch to Monad"}
        </button>
        {switchError && <p className="wallet-switch-note" role="alert">{switchMessage(switchError)}</p>}
      </div>
    );
  }

  return (
    <div className="wallet-control" ref={root} data-connect-phase={connectPhase}>
      <button className="wallet-button connected" type="button" onClick={() => setMenuOpen((value) => !value)} aria-expanded={menuOpen} aria-haspopup="menu">{short(address)} <span>⌄</span></button>
      {menuOpen && <div className="wallet-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => void copyAddress()}>{copied ? "COPIED ✓" : "COPY ADDRESS"}</button>
        <a role="menuitem" href={`https://monadscan.com/address/${address}`} target="_blank" rel="noreferrer">VIEW ON MONADSCAN ↗</a>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); disconnect(); }}>DISCONNECT</button>
      </div>}
    </div>
  );
}

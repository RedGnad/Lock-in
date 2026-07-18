"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { zeroAddress, type Address, type Hash } from "viem";
import { useAccount, useChainId, useConfig, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi } from "@/src/lock-in-abi";
import { lockInDuolingoAbi } from "@/src/lock-in-duolingo-abi";
import { duolingoEscrowAddress, monad } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { ensureWalletSession } from "@/src/wallet-auth-client";
import { PINNED_DUOLINGO_EVIDENCE_SIGNER, resolveDuolingoMode, type DuolingoMode } from "@/src/duolingo-escrow-client";

const POLL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;
const pinnedSigner = (process.env.NEXT_PUBLIC_DUOLINGO_EVIDENCE_SIGNER || PINNED_DUOLINGO_EVIDENCE_SIGNER).toLowerCase();

export const RATE_LIMIT_MESSAGE =
  "Duolingo's secure proof is busy right now. This is a temporary limit, not an error with your Lock. Wait a minute, then try again.";

/** A temporary rate limit, from our own API or from Reclaim. The UI treats it separately from a real error. */
export function isRateLimited(error: unknown): boolean {
  const m = error instanceof Error ? error.message : String(error);
  return /too many attempts|too many requests|rate ?limit|\b429\b/i.test(m);
}

/**
 * Turns any raw error into one calm, user-facing sentence. Users must never see a stack, an env var name, a
 * contract selector, or an internal note, so anything not explicitly recognised falls back to a generic line
 * rather than echoing the raw message.
 */
export function friendlyEscrowError(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  if (isRateLimited(error)) return RATE_LIMIT_MESSAGE;
  if (/user rejected|user denied|rejected the request/i.test(m)) return "You cancelled the transaction.";
  if (/insufficient funds|exceeds balance|more MON/i.test(m)) return "You need a little more MON for network gas.";
  if (/CreationIsPaused|JoiningIsPaused|CompletionIsPaused|canary is paused|not open yet|not available|not configured/i.test(m)) {
    return "Duolingo staking is not open right now. Please try again later.";
  }
  if (/InvalidStake|stake from 0\.1|stake of/i.test(m)) return "Choose a stake of 0.1, 0.5 or 1 USDC.";
  if (/expired|AttestationExpired|InvalidAttestationWindow/i.test(m)) return "That proof expired before it was used. Prove your XP again.";
  if (/InvalidConfigurationHash|InvalidMissionPolicy|terms changed/i.test(m)) return "The Lock's terms changed. Please start again.";
  if (/already been recorded|already recorded|NullifierAlreadyUsed|AlreadyCompleted/i.test(m)) return "That proof was already used. Start a new one to try again.";
  if (/different Duolingo account|IdentityMismatch|not the one you started/i.test(m)) return "This is a different Duolingo account than the one you started with.";
  if (/challenge window|OutsideChallengeWindow|submission window|not started/i.test(m)) return "This Lock isn't open for that step right now.";
  if (/did not fill|UnderfilledPact/i.test(m)) return "This Lock didn't fill, so it can't be completed.";
  if (/not a participant|NotParticipant/i.test(m)) return "You haven't joined this Lock.";
  if (/starting xp/i.test(m)) return "Verify your starting XP before your final XP.";
  if (/duolingo username|enter your duolingo/i.test(m)) return "Enter your Duolingo username.";
  if (/pop-?up|proof window|blocked/i.test(m)) return "Your browser blocked the proof window. Allow pop-ups, then try again.";
  if (/timed out/i.test(m)) return "The proof timed out. Please try again.";
  // Anything else, including any technical detail, collapses to one calm line.
  return "Something went wrong. Please try again.";
}

/** The verify-route payload, plus the createNonce the session assigned (needed to call createPact). */
export type ProofResult = {
  phase: "baseline" | "final";
  intent?: "create" | "join";
  createNonce?: string | null;
  configHash?: string;
  targetXp?: number;
  baselineXp?: number;
  finalXp?: number;
  earnedXp?: number;
  passed?: boolean;
  observedAt?: number;
  attestation?: Record<string, unknown>;
};

/**
 * Runs one financial proof: opens the pre-supplied portal at the Reclaim URL, then polls the escrow verify
 * route until it returns an attestation or a real refusal. The portal MUST be opened synchronously in the
 * click handler and passed in; a window opened after an await is blocked by every browser.
 */
export async function runEscrowProof(opts: {
  address: string;
  signMessage: (message: string) => Promise<string>;
  portal: Window | null;
  sessionBody: Record<string, unknown>;
  onStatus: (status: string) => void;
}): Promise<ProofResult> {
  const { address, signMessage, portal, sessionBody, onStatus } = opts;
  onStatus("OPENING SECURE PROOF…");
  await ensureWalletSession(address, signMessage);
  const started = await fetch("/api/duolingo/escrow/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(sessionBody),
  });
  const session = await started.json();
  if (!started.ok) throw new Error(session.error || "Could not start the proof");
  if (portal) portal.location.href = session.requestUrl;

  onStatus("WAITING FOR YOUR PROOF…");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const response = await fetch("/api/duolingo/escrow/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    // 202 = Reclaim has not returned the proof yet. Keep polling calmly until the global timeout.
    if (response.status === 202) {
      if (Date.now() > deadline) throw new Error("The proof timed out. Try again.");
      continue;
    }
    // 429 = a transient limit. Respect Retry-After and keep waiting rather than aborting the whole flow.
    if (response.status === 429) {
      const retryMs = Math.max(1_000, (Number(response.headers.get("Retry-After")) || 5) * 1_000);
      if (Date.now() + retryMs > deadline) throw new Error("The proof timed out. Try again.");
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      portal?.close();
      return { ...payload, createNonce: session.createNonce } as ProofResult;
    }
    // Anything else is terminal: surface the reason and stop.
    throw new Error(payload.error || "The proof was rejected");
  }
}

export type EscrowChain = {
  address: Address | undefined;
  mode: DuolingoMode;
  chainOk: boolean;
  token: Address;
  decimals: number;
  symbol: string;
  minStake: bigint | undefined;
  maxStake: bigint | undefined;
  allowance: bigint;
  balance: bigint;
  refetchAllowance: () => void;
};

/** Reads escrow B's terms, pauses, signer and the wallet's token allowance and balance. */
export function useEscrowChain(): EscrowChain {
  const { address } = useAccount();
  const chainId = useChainId();
  const contract = duolingoEscrowAddress || zeroAddress;
  const enabled = Boolean(duolingoEscrowAddress);
  const q = (extra: Record<string, unknown> = {}) => ({ enabled, ...extra });

  const { data: tokenAddress } = useReadContract({ address: contract, abi: lockInDuolingoAbi, functionName: "stakeToken", query: q() });
  const { data: minStake } = useReadContract({ address: contract, abi: lockInDuolingoAbi, functionName: "MIN_STAKE", query: q() });
  const { data: maxStake } = useReadContract({ address: contract, abi: lockInDuolingoAbi, functionName: "MAX_STAKE", query: q() });
  const { data: signer } = useReadContract({ address: contract, abi: lockInDuolingoAbi, functionName: "evidenceSigner", query: q() });
  const { data: creationPaused } = useReadContract({ address: contract, abi: lockInDuolingoAbi, functionName: "creationPaused", query: q({ refetchInterval: 20_000 }) });
  const { data: joiningPaused } = useReadContract({ address: contract, abi: lockInDuolingoAbi, functionName: "joiningPaused", query: q({ refetchInterval: 20_000 }) });
  const { data: completionPaused } = useReadContract({ address: contract, abi: lockInDuolingoAbi, functionName: "completionPaused", query: q({ refetchInterval: 20_000 }) });

  const token = (tokenAddress || zeroAddress) as Address;
  const { data: decimals = 6 } = useReadContract({ address: token, abi: erc20Abi, functionName: "decimals", query: { enabled: token !== zeroAddress } });
  const { data: symbol = "USDC" } = useReadContract({ address: token, abi: erc20Abi, functionName: "symbol", query: { enabled: token !== zeroAddress } });
  const { data: allowance = 0n, refetch: refetchAllowance } = useReadContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [address || zeroAddress, contract],
    query: { enabled: Boolean(address && enabled && token !== zeroAddress) },
  });
  const { data: balance = 0n } = useReadContract({
    address: token, abi: erc20Abi, functionName: "balanceOf", args: [address || zeroAddress],
    query: { enabled: Boolean(address && token !== zeroAddress), refetchInterval: 15_000 },
  });

  const anyPaused = creationPaused === undefined || joiningPaused === undefined || completionPaused === undefined
    ? null
    : Boolean(creationPaused || joiningPaused || completionPaused);
  const signerVerified = pinnedSigner && typeof signer === "string" ? signer.toLowerCase() === pinnedSigner : undefined;
  const mode = resolveDuolingoMode({ hasAddress: enabled, anyPaused, signerVerified });

  return {
    address,
    mode,
    chainOk: chainId === monad.id,
    token,
    decimals,
    symbol,
    minStake,
    maxStake,
    allowance,
    balance,
    refetchAllowance: () => void refetchAllowance(),
  };
}

type Pending = { account: Address; action: string; hash: Hash };
function pendingKey(account: Address) { return `lock-in:duo-pending:${account.toLowerCase()}`; }
function savePending(account: Address, value: Pending | null) {
  try {
    if (value) window.localStorage.setItem(pendingKey(account), JSON.stringify(value));
    else window.localStorage.removeItem(pendingKey(account));
  } catch {}
}
export function readPending(account: Address): Pending | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(pendingKey(account)) || "null") as Pending | null;
    if (!parsed || !/^0x[0-9a-f]{64}$/i.test(parsed.hash) || !/^0x[0-9a-f]{40}$/i.test(parsed.account)) return null;
    return parsed;
  } catch { return null; }
}

/** A gas-estimated write with a Monad buffer, a native-balance check, and a recoverable pending record. */
export function useEscrowWrite() {
  const config = useConfig();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [recovering, setRecovering] = useState<string | null>(null);

  // Recover a transaction that was in flight when the tab closed, so a reload does not double-send.
  useEffect(() => {
    if (!address) return;
    const pending = readPending(address);
    if (!pending || pending.account.toLowerCase() !== address.toLowerCase()) return;
    let alive = true;
    setRecovering(pending.action);
    waitForTransactionReceipt(config, { hash: pending.hash, confirmations: 1 })
      .catch(() => undefined)
      .finally(() => { if (alive) { savePending(address, null); setRecovering(null); } });
    return () => { alive = false; };
  }, [address, config]);

  async function writeWithGas(request: Parameters<typeof writeContractAsync>[0], action: string): Promise<Hash> {
    if (!address || !publicClient) throw new Error("Wallet or Monad RPC unavailable");
    if (readPending(address)) throw new Error("A previous transaction is still pending. Check your wallet.");
    const estimate = await publicClient.estimateContractGas({ ...request, account: address } as never);
    const gas = addMonadGasBuffer(estimate);
    const [nativeBalance, gasPrice] = await Promise.all([publicClient.getBalance({ address }), publicClient.getGasPrice()]);
    if (nativeBalance < gas * gasPrice) throw new Error("insufficient funds for gas");
    const hash = await writeContractAsync({ ...request, gas } as never);
    savePending(address, { account: address, action, hash });
    const receipt = await waitForTransactionReceipt(config, { hash, confirmations: 1 });
    savePending(address, null);
    if (receipt.status !== "success") throw new Error("Transaction reverted");
    return hash;
  }

  return { writeWithGas, recovering, publicClient, config };
}

export const escrowAbi = lockInDuolingoAbi;

export function stakeOptions(): readonly string[] {
  return ["0.1", "0.5", "1"];
}

export const RECLAIM_NOTICE =
  "A secure Reclaim window will open. Reclaim may ask you to sign in to Duolingo. Lock In never receives your password.";

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1_000)), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useMemoStake(input: string, decimals: number): bigint {
  return useMemo(() => {
    try {
      const [whole, frac = ""] = input.split(".");
      const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
      return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
    } catch {
      return 0n;
    }
  }, [input, decimals]);
}

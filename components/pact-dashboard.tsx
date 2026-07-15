"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatUnits, zeroAddress, type Address, type Hash } from "viem";
import { useAccount, useChainId, useConfig, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, lockInAbi, type PactTuple } from "@/src/lock-in-abi";
import { escrowAddress, monad } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { ActionDialog } from "@/components/action-dialog";
import { PactCrew } from "@/components/pact-crew";

type ProductActions = { join: boolean; checkIns: boolean };
type PendingAction = { account: Address; action: string; hash: Hash };

function formatDate(seconds: bigint) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(Number(seconds) * 1_000);
}

function pendingKey(pactId: bigint, account: Address) {
  return `lock-in:pending-pact:${pactId}:${account.toLowerCase()}`;
}

function readPending(pactId: bigint, account: Address): PendingAction | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(pendingKey(pactId, account)) || "null") as PendingAction | null;
    if (!parsed || !/^0x[0-9a-f]{64}$/i.test(parsed.hash) || !/^0x[0-9a-f]{40}$/i.test(parsed.account)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePending(pactId: bigint, account: Address, value: PendingAction | null) {
  try {
    if (value) window.localStorage.setItem(pendingKey(pactId, account), JSON.stringify(value));
    else window.localStorage.removeItem(pendingKey(pactId, account));
  } catch {
    // Wallet state remains the source of truth if browser storage is unavailable.
  }
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|user denied|rejected the request/i.test(message)) return "Transaction cancelled.";
  if (/insufficient funds|exceeds balance/i.test(message)) return "You need more MON for network gas.";
  if (/JoinClosed/i.test(message)) return "Registration is closed.";
  if (/JoiningIsPaused/i.test(message)) return "Joining is paused for safety.";
  if (/CheckInsArePaused/i.test(message)) return "Check-ins are paused for safety.";
  if (/CheckInOutsideDay/i.test(message)) return "This check-in window is closed.";
  if (/DayAlreadyCompleted/i.test(message)) return "This day is already checked in.";
  if (/UnderfilledPact/i.test(message)) return "The pact did not reach its minimum crew.";
  if (/FinalizationTooEarly/i.test(message)) return "This pact cannot settle yet.";
  if (/NotEligible/i.test(message)) return "You did not reach the completion target.";
  return "The transaction did not complete. Refresh the pact before retrying.";
}

export function PactDashboard({ id }: { id: string }) {
  const config = useConfig();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const pactId = /^\d+$/.test(id) ? BigInt(id) : 0n;
  const contract = escrowAddress || zeroAddress;
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [entryAccepted, setEntryAccepted] = useState(false);
  const [joinReviewOpen, setJoinReviewOpen] = useState(false);
  const [actions, setActions] = useState<ProductActions>({ join: false, checkIns: false });
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));

  useEffect(() => {
    let alive = true;
    async function sync() {
      try {
        const [block, response] = await Promise.all([
          publicClient?.getBlock({ blockTag: "latest" }),
          fetch("/api/health", { cache: "no-store" }),
        ]);
        const health = await response.json();
        if (alive) {
          if (block) setNowSeconds(Number(block.timestamp));
          setActions({ join: Boolean(health.actions?.join), checkIns: Boolean(health.actions?.checkIns) });
        }
      } catch {
        if (alive) setActions({ join: false, checkIns: false });
      }
    }
    void sync();
    const timer = window.setInterval(() => void sync(), 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [publicClient]);

  const reads = useReadContracts({
    contracts: [
      { address: contract, abi: lockInAbi, functionName: "pacts", args: [pactId] },
      { address: contract, abi: lockInAbi, functionName: "joined", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "completionBitmap", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "completionCount", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "claimed", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "stakeToken" },
    ],
    query: { enabled: Boolean(escrowAddress && pactId > 0n), refetchInterval: 10_000 },
  });
  const pact = reads.data?.[0]?.result as PactTuple | undefined;
  const isJoined = Boolean(reads.data?.[1]?.result);
  const bitmap = BigInt(reads.data?.[2]?.result || 0);
  const completed = Number(reads.data?.[3]?.result || 0);
  const hasClaimed = Boolean(reads.data?.[4]?.result);
  const token = (reads.data?.[5]?.result as Address | undefined) || zeroAddress;
  const tokenReads = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "allowance", args: [address || zeroAddress, contract] },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [address || zeroAddress] },
    ],
    query: { enabled: token !== zeroAddress && Boolean(address), refetchInterval: 15_000 },
  });
  const decimals = Number(tokenReads.data?.[0]?.result || 6);
  const symbol = String(tokenReads.data?.[1]?.result || "USDC");
  const allowance = BigInt(tokenReads.data?.[2]?.result || 0);
  const tokenBalance = BigInt(tokenReads.data?.[3]?.result || 0);

  useEffect(() => {
    if (!address || pactId <= 0n) return;
    const pending = readPending(pactId, address);
    if (!pending || pending.account.toLowerCase() !== address.toLowerCase()) return;
    let alive = true;
    busyRef.current = true;
    setBusyAction(pending.action);
    setTxHash(pending.hash);
    setMessage(`Recovering your ${pending.action} transaction…`);
    waitForTransactionReceipt(config, { hash: pending.hash, confirmations: 1 })
      .then((receipt) => {
        if (!alive) return;
        savePending(pactId, address, null);
        setMessage(receipt.status === "success" ? "Transaction confirmed." : "The transaction reverted.");
        void reads.refetch();
        void tokenReads.refetch();
      })
      .catch(() => { if (alive) setMessage("Transaction status is unavailable. Check it on Monadscan before retrying."); })
      .finally(() => {
        if (alive) {
          busyRef.current = false;
          setBusyAction(null);
        }
      });
    return () => { alive = false; };
  }, [address, config, pactId]);

  const currentDay = useMemo(() => {
    if (!pact || nowSeconds < Number(pact[1])) return -1;
    return Math.min(pact[6], Math.floor((nowSeconds - Number(pact[1])) / 86_400));
  }, [nowSeconds, pact]);

  async function send(request: Parameters<typeof writeContractAsync>[0], action: string) {
    if (!address || !publicClient) throw new Error("Wallet or Monad RPC unavailable");
    if (busyRef.current || readPending(pactId, address)) throw new Error("A transaction is already pending");
    if (chainId !== monad.id) throw new Error("Switch to Monad mainnet");
    busyRef.current = true;
    setBusyAction(action);
    try {
      const estimate = await publicClient.estimateContractGas({ ...request, account: address } as never);
      const gas = addMonadGasBuffer(estimate);
      const [nativeBalance, gasPrice] = await Promise.all([publicClient.getBalance({ address }), publicClient.getGasPrice()]);
      if (nativeBalance < gas * gasPrice) throw new Error("insufficient funds for gas");
      const hash = await writeContractAsync({ ...request, gas } as never);
      setTxHash(hash);
      savePending(pactId, address, { account: address, action, hash });
      const receipt = await waitForTransactionReceipt(config, { hash, confirmations: 1 });
      savePending(pactId, address, null);
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      await Promise.all([reads.refetch(), tokenReads.refetch()]);
      return hash;
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  async function join() {
    if (!address || !escrowAddress || !pact) return setMessage("Connect your wallet first.");
    if (!actions.join) return setMessage("Joining is paused for safety.");
    if (!entryAccepted) return setMessage("Accept the Rules to continue.");
    if (tokenBalance < pact[2]) return setMessage(`You need ${formatUnits(pact[2], decimals)} ${symbol} to join.`);
    setJoinReviewOpen(false);
    try {
      if (allowance < pact[2]) {
        setMessage(`Approve ${formatUnits(pact[2], decimals)} ${symbol} in your wallet…`);
        await send({ address: token, abi: erc20Abi, functionName: "approve", args: [escrowAddress, pact[2]] }, "approval");
      }
      setMessage("Joining the pact…");
      await send({ address: escrowAddress, abi: lockInAbi, functionName: "joinPact", args: [pactId] }, "join");
      setMessage("You are locked in.");
    } catch (error) {
      setMessage(friendlyError(error));
    }
  }

  async function checkIn(dayIndex: number) {
    if (!address || !escrowAddress) return setMessage("Connect your wallet first.");
    if (!actions.checkIns) return setMessage("Check-ins are paused for safety.");
    try {
      setMessage(`Checking in for day ${dayIndex + 1}…`);
      await send({ address: escrowAddress, abi: lockInAbi, functionName: "checkIn", args: [pactId, dayIndex] }, "check-in");
      setMessage(`Day ${dayIndex + 1} locked in ✓`);
    } catch (error) {
      setMessage(friendlyError(error));
    }
  }

  async function finalizeOrClaim(action: "finalize" | "claim" | "cancel") {
    if (!escrowAddress) return;
    try {
      const labels = { finalize: "Settling the pact…", claim: "Claiming your payout…", cancel: "Cancelling the pact…" };
      setMessage(labels[action]);
      const functionName = action === "finalize" ? "finalizePact" : action === "claim" ? "claim" : "cancelPact";
      await send({ address: escrowAddress, abi: lockInAbi, functionName, args: [pactId] } as never, action);
      setMessage(action === "finalize" ? "Pact settled." : action === "claim" ? "Payout received." : "Pact cancelled. Refunds can now be enabled.");
    } catch (error) {
      setMessage(friendlyError(error));
    }
  }

  async function sharePact() {
    const url = window.location.href;
    const text = pact
      ? `Join my Lock In: ${pact[7]} check-ins in ${pact[6]} days, ${formatUnits(pact[2], decimals)} ${symbol} each. Finishers split the pool.`
      : "Join my Lock In challenge.";
    try {
      const usedShareSheet = typeof navigator.share === "function";
      if (usedShareSheet) await navigator.share({ title: `Lock In pact #${id}`, text, url });
      else await navigator.clipboard.writeText(url);
      setMessage(usedShareSheet ? "Invite ready to share." : "Invite link copied.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Copy this page URL to invite a friend.");
    }
  }

  if (!escrowAddress) return <main className="pact-shell"><div className="empty-state"><strong>Lock In is not configured.</strong><Link href="/">Back home</Link></div></main>;
  if (pactId <= 0n) return <main className="pact-shell"><div className="empty-state"><strong>That pact ID is not valid.</strong><Link href="/#join">Find a pact</Link></div></main>;
  if (reads.isPending) return <main className="pact-shell"><div className="empty-state"><strong>Reading pact #{id} from Monad…</strong></div></main>;
  if (reads.isError) return <main className="pact-shell"><div className="empty-state"><strong>Monad is not responding.</strong><button className="secondary-button" onClick={() => reads.refetch()}>TRY AGAIN</button></div></main>;
  if (!pact || pact[0] === zeroAddress) return <main className="pact-shell"><div className="empty-state"><strong>Pact #{id} does not exist.</strong><Link href="/#join">Find a pact</Link></div></main>;

  const startsAt = pact[1];
  const durationDays = pact[6];
  const requiredCompletions = pact[7];
  const minParticipants = pact[8];
  const endsAt = startsAt + BigInt(durationDays * 86_400);
  const registration = nowSeconds < Number(startsAt) && !pact[14];
  const underfilled = !registration && pact[3] < minParticipants && !pact[13] && !pact[14];
  const active = !registration && nowSeconds < Number(endsAt) && !underfilled && !pact[13] && !pact[14];
  const canSettle = pact[14] || underfilled || nowSeconds >= Number(endsAt);
  const targetReached = completed >= requiredCompletions;
  const payoutEligible = isJoined && (pact[14] || pact[4] === 0 || targetReached);
  const progress = Math.min(100, Math.round((completed / requiredCompletions) * 100));
  const displayedPool = pact[13] ? pact[12] : pact[2] * BigInt(pact[3]);
  const playersNeeded = Math.max(0, minParticipants - pact[3]);
  const todayDone = currentDay >= 0 && currentDay < durationDays && (bitmap & (1n << BigInt(currentDay))) !== 0n;
  const canCheckIn = active && currentDay >= 0 && currentDay < durationDays && isJoined && !todayDone && !targetReached && actions.checkIns && !busyAction;
  const status = pact[13] && pact[14] ? "REFUND READY" : pact[13] ? "SETTLED" : pact[14] ? "CANCELLED" : registration ? "REGISTRATION" : underfilled ? "UNDERFILLED" : active ? "ACTIVE" : "SETTLEMENT READY";
  const roomHeading = registration
    ? playersNeeded > 0 ? `${pact[3]} joined. ${playersNeeded} more to start.` : "Your crew is ready."
    : targetReached ? "You kept the pact."
    : active && !actions.checkIns ? "Check-ins are temporarily paused."
    : active && todayDone ? "Today is locked in."
    : active ? "Check in before the window closes."
    : status;

  return (
    <main className="pact-shell">
      <div className="pact-topline"><Link href="/">← Home</Link><span>MONAD CHECK-IN / #{id.padStart(4, "0")}</span><button type="button" onClick={sharePact}>SHARE ↗</button></div>
      <section className="pact-hero">
        <div><div className="live-pill"><i /> {status}</div><h1>{requiredCompletions} check-ins<br/><em>in {durationDays} days</em></h1><p>{isJoined ? `${completed} locked in` : `Starts ${formatDate(startsAt)}`}</p></div>
        <div className="pot"><span>{pact[13] ? "UNCLAIMED POOL" : "TOTAL POOL"}</span><strong>{formatUnits(displayedPool, decimals)}</strong><b>{symbol}</b><small>{pact[3]} player{pact[3] === 1 ? "" : "s"} · {minParticipants} needed</small></div>
      </section>

      <section className={`pact-now ${registration ? "forming" : active ? "active" : ""}`}>
        <div>
          <span>{registration ? "CREW CHECK" : active && currentDay >= 0 ? `TODAY · DAY ${currentDay + 1}` : "PACT STATUS"}</span>
          <h2>{roomHeading}</h2>
          {registration ? <p>Registration closes {formatDate(startsAt)}.</p> : active && !actions.checkIns ? <p>The safety switch is active. Watch this page for reopening or refund instructions.</p> : active ? <p>Today&apos;s window closes {formatDate(startsAt + BigInt((currentDay + 1) * 86_400))}.</p> : <p>{pact[13] && pact[14] ? "Refunds are ready." : pact[13] ? "Payouts are ready." : `Program ended ${formatDate(endsAt)}.`}</p>}
        </div>
        <div className="pact-now-actions">
          {registration && isJoined && <button className="lock-button" type="button" onClick={sharePact}>INVITE A PLAYER</button>}
          {registration && !isJoined && <a className="primary-link" href="#join-pact">JOIN THIS PACT</a>}
          {canCheckIn && <button className="lock-button" type="button" onClick={() => void checkIn(currentDay)}>CHECK IN TODAY</button>}
          {!registration && isJoined && !canCheckIn && actions.checkIns && <button className="secondary-button" type="button" onClick={sharePact}>SHARE PROGRESS</button>}
        </div>
      </section>

      <PactCrew pactId={pactId} participantCount={pact[3]} durationDays={durationDays} requiredCompletions={requiredCompletions} currentDay={currentDay} currentAddress={address}/>

      <section className="pact-grid">
        <div className="days-card">
          <div className="section-title"><span>{isJoined ? "YOUR STREAK" : "PACT STREAK"}</span><b>{completed}/{requiredCompletions} REQUIRED</b></div>
          <div className="progress-track" role="progressbar" aria-label="Pact progress" aria-valuemin={0} aria-valuemax={requiredCompletions} aria-valuenow={completed}><i style={{ width: `${progress}%` }} /></div>
          <div className="day-list">
            {Array.from({ length: durationDays }, (_, day) => {
              const done = (bitmap & (1n << BigInt(day))) !== 0n;
              const isToday = day === currentDay;
              return <div className={`day-row ${done ? "done" : isToday ? "today" : day < currentDay ? "past" : "upcoming"}`} key={day}><div><b>D{day + 1}</b><span>{formatDate(startsAt + BigInt(day * 86_400))}</span></div><button disabled={!isJoined || done || !isToday || !active || targetReached || !actions.checkIns || Boolean(busyAction)} onClick={() => void checkIn(day)}>{done ? "LOCKED IN ✓" : targetReached ? "TARGET MET" : !active ? "CLOSED" : isToday ? busyAction === "check-in" ? "CHECKING IN…" : "CHECK IN" : day < currentDay ? "MISSED" : "LOCKED"}</button></div>;
            })}
          </div>
        </div>
        <details className="pact-details"><summary>PACT DETAILS <span>+</span></summary><div className="details-body"><div><span>MISSION</span><b>Monad check-in</b></div><div><span>STAKE / PLAYER</span><b>{formatUnits(pact[2], decimals)} {symbol}</b></div><div><span>REGISTRATION CLOSES</span><b>{formatDate(startsAt)}</b></div><div><span>PROGRAM ENDS</span><b>{formatDate(endsAt)}</b></div><div><span>MINIMUM CREW</span><b>{minParticipants} players</b></div><div><span>FINISHERS</span><b>{pact[4]}</b></div></div></details>
      </section>

      <div className="pact-actions" id="join-pact">
        {!isJoined && registration && <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>}
        {!isJoined && registration && <button className="lock-button" disabled={!entryAccepted || !actions.join || Boolean(busyAction)} onClick={() => address ? setJoinReviewOpen(true) : setMessage("Connect your wallet to join.")}>JOIN FOR {formatUnits(pact[2], decimals)} {symbol}</button>}
        {!isJoined && registration && !actions.join && <p>Joining is temporarily paused for safety.</p>}
        {!isJoined && !registration && <p>Registration is closed.</p>}
        {isJoined && registration && address?.toLowerCase() === pact[0].toLowerCase() && !pact[14] && <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => void finalizeOrClaim("cancel")}>CANCEL BEFORE START</button>}
        {!pact[13] && canSettle && <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => void finalizeOrClaim("finalize")}>{pact[14] || underfilled ? "ENABLE REFUNDS" : "SETTLE PACT"}</button>}
        {pact[13] && payoutEligible && !hasClaimed && <button className="lock-button" disabled={Boolean(busyAction)} onClick={() => void finalizeOrClaim("claim")}>{pact[14] || pact[4] === 0 ? "CLAIM MY REFUND" : "CLAIM MY PAYOUT"}</button>}
        {pact[13] && hasClaimed && <p>Your {pact[14] || pact[4] === 0 ? "refund" : "payout"} has already been claimed.</p>}
        {pact[13] && isJoined && !payoutEligible && <p>You missed the target, so your stake went to the finishers.</p>}
        {message && <p className="form-status" aria-live="polite">{message}{txHash && <> · <a href={`https://monadscan.com/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction ↗</a></>}</p>}
      </div>

      <ActionDialog open={joinReviewOpen} title="Join this pact?" eyebrow="Transaction review" confirmLabel={`Join for ${formatUnits(pact[2], decimals)} ${symbol}`} busy={busyAction === "approval" || busyAction === "join"} onClose={() => setJoinReviewOpen(false)} onConfirm={join}>
        <p>Real USDC and gas are used on Monad mainnet. This unaudited beta proves only a wallet check-in, which software can automate—not a real-world activity. The 1 USDC cap is per pact.</p>
        <Link className="dialog-link" href="/rules">Read the rules ↗</Link>
      </ActionDialog>
    </main>
  );
}

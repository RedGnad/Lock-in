"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatUnits, zeroAddress, type Address, type Hash } from "viem";
import { useAccount, useChainId, useConfig, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import {
  DUOLINGO_XP_MISSION,
  STRAVA_RUN_MISSION,
  emptyBaselineEvidence,
  erc20Abi,
  lockInAbi,
  type BaselineEvidence,
  type PactTuple,
} from "@/src/lock-in-abi";
import { escrowAddress, monad } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { duolingoOwnershipCode } from "@/src/duolingo-proof-policy";
import { formatMissionTarget, missionByType } from "@/src/missions";
import { runReclaimProofV5 } from "@/src/reclaim-client-v5";
import { stravaActivityCode } from "@/src/pact-code";
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

function duolingoUsernameKey(pactId: bigint, account: Address) {
  return `lock-in:duolingo:${pactId}:${account.toLowerCase()}`;
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|user denied|rejected the request/i.test(message)) return "Transaction cancelled.";
  if (/insufficient funds|exceeds balance/i.test(message)) return "You need more MON for network gas.";
  if (/JoinClosed/i.test(message)) return "Registration is closed.";
  if (/JoiningIsPaused/i.test(message)) return "Joining is paused for safety.";
  if (/EvidenceIsPaused/i.test(message)) return "Verification is paused for safety.";
  if (/CompletionOutsideDay/i.test(message)) return "This verification window is closed.";
  if (/DayAlreadyCompleted/i.test(message)) return "This day is already verified.";
  if (/InvalidMetric/i.test(message)) return "The verified activity did not reach the daily target or reused prior progress.";
  if (/UnderfilledPact/i.test(message)) return "The lock did not reach its minimum crew.";
  if (/FinalizationTooEarly/i.test(message)) return "This lock cannot settle yet.";
  if (/NotEligible/i.test(message)) return "You did not reach the completion target.";
  if (/Reclaim|verification|Duolingo|Strava|bio|GPS|title|session|profile|proof|XP/i.test(message) && message.length < 220) return message;
  return "The transaction did not complete. Refresh the lock before retrying.";
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
  const proofBusyRef = useRef(false);
  const [entryAccepted, setEntryAccepted] = useState(false);
  const [joinReviewOpen, setJoinReviewOpen] = useState(false);
  const [duolingoUsername, setDuolingoUsername] = useState("");
  const [actions, setActions] = useState<ProductActions>({ join: false, checkIns: false });
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));

  useEffect(() => {
    if (!address || pactId <= 0n) return;
    try {
      const saved = window.localStorage.getItem(duolingoUsernameKey(pactId, address));
      if (saved && /^[A-Za-z0-9._-]{1,64}$/.test(saved)) setDuolingoUsername(saved);
    } catch {}
  }, [address, pactId]);

  useEffect(() => {
    if (!address || pactId <= 0n || !/^[A-Za-z0-9._-]{1,64}$/.test(duolingoUsername)) return;
    try { window.localStorage.setItem(duolingoUsernameKey(pactId, address), duolingoUsername); } catch {}
  }, [address, duolingoUsername, pactId]);

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
    return Math.min(pact[7], Math.floor((nowSeconds - Number(pact[1])) / 86_400));
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
    if (proofBusyRef.current) return;
    if (!address || !escrowAddress || !pact) return setMessage("Connect your wallet first.");
    if (!actions.join) return setMessage("Joining is paused for safety.");
    if (!entryAccepted) return setMessage("Accept the Rules to continue.");
    if (tokenBalance < pact[2]) return setMessage(`You need ${formatUnits(pact[2], decimals)} ${symbol} to join.`);
    if (pact[10] === DUOLINGO_XP_MISSION && !/^[A-Za-z0-9._-]{1,64}$/.test(duolingoUsername.trim())) {
      return setMessage("Enter your Duolingo username.");
    }
    setJoinReviewOpen(false);
    proofBusyRef.current = true;
    setBusyAction("proof");
    try {
      if (allowance < pact[2]) {
        setMessage(`Approve ${formatUnits(pact[2], decimals)} ${symbol} in your wallet…`);
        await send({ address: token, abi: erc20Abi, functionName: "approve", args: [escrowAddress, pact[2]] }, "approval");
        if (pact[10] === DUOLINGO_XP_MISSION) {
          setMessage("USDC approved. Click join again to verify Duolingo and enter the lock.");
          return;
        }
      }
      let baseline: BaselineEvidence = emptyBaselineEvidence;
      if (pact[10] === DUOLINGO_XP_MISSION) {
        setBusyAction("proof");
        const result = await runReclaimProofV5({
          walletAddress: address,
          pactId: pactId.toString(),
          phase: "baseline",
          intent: "join",
          username: duolingoUsername.trim(),
        }, setMessage);
        if (!result.baseline) throw new Error("Duolingo baseline was not returned");
        baseline = result.baseline;
      }
      setMessage("Joining the lock…");
      await send({ address: escrowAddress, abi: lockInAbi, functionName: "joinPact", args: [pactId, baseline] }, "join");
      setMessage("You are locked in.");
    } catch (error) {
      setMessage(friendlyError(error));
    } finally {
      proofBusyRef.current = false;
      if (!busyRef.current) setBusyAction(null);
    }
  }

  async function checkIn(dayIndex: number) {
    if (proofBusyRef.current || busyRef.current) return;
    if (!address || !escrowAddress) return setMessage("Connect your wallet first.");
    if (!actions.checkIns) return setMessage("Check-ins are paused for safety.");
    proofBusyRef.current = true;
    setBusyAction("proof");
    try {
      if (pact?.[10] === DUOLINGO_XP_MISSION && !/^[A-Za-z0-9._-]{1,64}$/.test(duolingoUsername.trim())) {
        return setMessage("Enter your Duolingo username in Lock details before verifying.");
      }
      const result = await runReclaimProofV5({
        walletAddress: address,
        pactId: pactId.toString(),
        phase: "completion",
        dayIndex,
        username: pact?.[10] === DUOLINGO_XP_MISSION ? duolingoUsername.trim() : undefined,
      }, setMessage);
      if (!result.completion) throw new Error("Verified completion was not returned");
      setMessage(`Publishing verified day ${dayIndex + 1}…`);
      await send({ address: escrowAddress, abi: lockInAbi, functionName: "submitCompletion", args: [pactId, dayIndex, result.completion] }, "verification");
      setMessage(`Day ${dayIndex + 1} verified ✓`);
    } catch (error) {
      setMessage(friendlyError(error));
    } finally {
      proofBusyRef.current = false;
      if (!busyRef.current) setBusyAction(null);
    }
  }

  async function finalizeOrClaim(action: "finalize" | "claim" | "cancel") {
    if (!escrowAddress) return;
    try {
      const labels = { finalize: "Settling the lock…", claim: "Claiming your payout…", cancel: "Cancelling the lock…" };
      setMessage(labels[action]);
      const functionName = action === "finalize" ? "finalizePact" : action === "claim" ? "claim" : "cancelPact";
      await send({ address: escrowAddress, abi: lockInAbi, functionName, args: [pactId] } as never, action);
      setMessage(action === "finalize" ? "Lock settled." : action === "claim" ? "Payout received." : "Lock cancelled. Refunds can now be enabled.");
    } catch (error) {
      setMessage(friendlyError(error));
    }
  }

  async function sharePact() {
    const url = window.location.href;
    const text = pact
      ? `Join my ${missionByType(pact[10]).name} Lock In: ${formatMissionTarget(pact[10], pact[3])}, ${pact[8]} wins in ${pact[7]} days, ${formatUnits(pact[2], decimals)} ${symbol} each. Finishers split the pool.`
      : "Join my Lock In challenge.";
    try {
      const usedShareSheet = typeof navigator.share === "function";
      if (usedShareSheet) await navigator.share({ title: `Lock In #${id}`, text, url });
      else await navigator.clipboard.writeText(url);
      setMessage(usedShareSheet ? "Invite ready to share." : "Invite link copied.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Copy this page URL to invite a friend.");
    }
  }

  async function copyProofValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied.`);
    } catch {
      setMessage(`Copy this ${label.toLowerCase()}: ${value}`);
    }
  }

  if (!escrowAddress) return <main className="pact-shell"><div className="empty-state"><strong>Lock In is not configured.</strong><Link href="/">Back home</Link></div></main>;
  if (pactId <= 0n) return <main className="pact-shell"><div className="empty-state"><strong>That lock ID is not valid.</strong><Link href="/#join">Find a lock</Link></div></main>;
  if (reads.isPending) return <main className="pact-shell"><div className="empty-state"><strong>Reading lock #{id} from Monad…</strong></div></main>;
  if (reads.isError) return <main className="pact-shell"><div className="empty-state"><strong>Monad is not responding.</strong><button className="secondary-button" onClick={() => reads.refetch()}>TRY AGAIN</button></div></main>;
  if (!pact || pact[0] === zeroAddress) return <main className="pact-shell"><div className="empty-state"><strong>Lock #{id} does not exist.</strong><Link href="/#join">Find a lock</Link></div></main>;

  const startsAt = pact[1];
  const durationDays = pact[7];
  const requiredCompletions = pact[8];
  const minParticipants = pact[9];
  const mission = missionByType(pact[10]);
  const targetLabel = formatMissionTarget(pact[10], pact[3]);
  const activityCode = pact[10] === STRAVA_RUN_MISSION && address && currentDay >= 0 && currentDay < pact[7]
    ? stravaActivityCode(pactId.toString(), address, currentDay)
    : null;
  const ownershipCode = pact[10] === DUOLINGO_XP_MISSION && address ? duolingoOwnershipCode(address) : null;
  const endsAt = startsAt + BigInt(durationDays * 86_400);
  const registration = nowSeconds < Number(startsAt) && !pact[14];
  const underfilled = !registration && pact[4] < minParticipants && !pact[13] && !pact[14];
  const active = !registration && nowSeconds < Number(endsAt) && !underfilled && !pact[13] && !pact[14];
  const canSettle = pact[14] || underfilled || nowSeconds >= Number(endsAt);
  const targetReached = completed >= requiredCompletions;
  const payoutEligible = isJoined && (pact[14] || pact[5] === 0 || targetReached);
  const progress = Math.min(100, Math.round((completed / requiredCompletions) * 100));
  const displayedPool = pact[13] ? pact[12] : pact[2] * BigInt(pact[4]);
  const playersNeeded = Math.max(0, minParticipants - pact[4]);
  const todayDone = currentDay >= 0 && currentDay < durationDays && (bitmap & (1n << BigInt(currentDay))) !== 0n;
  const canCheckIn = active && currentDay >= 0 && currentDay < durationDays && isJoined && !todayDone && !targetReached && actions.checkIns && !busyAction;
  const status = pact[13] && pact[14] ? "REFUND READY" : pact[13] ? "SETTLED" : pact[14] ? "CANCELLED" : registration ? "REGISTRATION" : underfilled ? "UNDERFILLED" : active ? "ACTIVE" : "SETTLEMENT READY";
  const roomHeading = registration
    ? playersNeeded > 0 ? `${pact[4]} joined. ${playersNeeded} more to start.` : "Your crew is ready."
    : targetReached ? "You kept the lock."
    : active && !actions.checkIns ? "Verification is temporarily paused."
    : active && todayDone ? "Today is verified."
    : active ? `${targetLabel} before the window closes.`
    : status;

  return (
    <main className="pact-shell">
      <div className="pact-topline"><Link href="/">← Home</Link><span>{mission.name.toUpperCase()} / #{id.padStart(4, "0")}</span><button type="button" onClick={sharePact}>SHARE ↗</button></div>
      <section className="pact-hero">
        <div><div className="live-pill"><i /> {status}</div><h1>{requiredCompletions} {mission.verb}<br/><em>in {durationDays} days</em></h1><p>{targetLabel} each · {isJoined ? `${completed} verified` : `Starts ${formatDate(startsAt)}`}</p></div>
        <div className="pot"><span>{pact[13] ? "UNCLAIMED POOL" : "TOTAL POOL"}</span><strong>{formatUnits(displayedPool, decimals)}</strong><b>{symbol}</b><small>{pact[4]} player{pact[4] === 1 ? "" : "s"} · {minParticipants} needed</small></div>
      </section>

      <section className={`pact-now ${registration ? "forming" : active ? "active" : ""}`}>
        <div>
          <span>{registration ? "CREW CHECK" : active && currentDay >= 0 ? `TODAY · DAY ${currentDay + 1}` : "LOCK STATUS"}</span>
          <h2>{roomHeading}</h2>
          {registration ? <p>Registration closes {formatDate(startsAt)}.</p> : active && !actions.checkIns ? <p>The safety switch is active. Watch this page for reopening or refund instructions.</p> : active ? <p>Verify through {mission.name} before {formatDate(startsAt + BigInt((currentDay + 1) * 86_400))}.</p> : <p>{pact[13] && pact[14] ? "Refunds are ready." : pact[13] ? "Payouts are ready." : `Program ended ${formatDate(endsAt)}.`}</p>}
        </div>
        <div className="pact-now-actions">
          {registration && isJoined && <button className="lock-button" type="button" onClick={sharePact}>INVITE A PLAYER</button>}
          {registration && !isJoined && <a className="primary-link" href="#join-lock">JOIN THIS LOCK</a>}
          {canCheckIn && <button className="lock-button" type="button" onClick={() => void checkIn(currentDay)}>VERIFY TODAY</button>}
          {!registration && isJoined && !canCheckIn && actions.checkIns && <button className="secondary-button" type="button" onClick={sharePact}>SHARE PROGRESS</button>}
        </div>
      </section>

      <PactCrew pactId={pactId} participantCount={pact[4]} durationDays={durationDays} requiredCompletions={requiredCompletions} currentDay={currentDay} currentAddress={address}/>

      <section className="pact-grid">
        <div className="days-card">
          <div className="section-title"><span>{isJoined ? "YOUR PROGRESS" : "LOCK PROGRESS"}</span><b>{completed}/{requiredCompletions} REQUIRED</b></div>
          <div className="progress-track" role="progressbar" aria-label="Lock progress" aria-valuemin={0} aria-valuemax={requiredCompletions} aria-valuenow={completed}><i style={{ width: `${progress}%` }} /></div>
          <div className="day-list">
            {Array.from({ length: durationDays }, (_, day) => {
              const done = (bitmap & (1n << BigInt(day))) !== 0n;
              const isToday = day === currentDay;
              return <div className={`day-row ${done ? "done" : isToday ? "today" : day < currentDay ? "past" : "upcoming"}`} key={day}><div><b>D{day + 1}</b><span>{formatDate(startsAt + BigInt(day * 86_400))}</span></div><button disabled={!isJoined || done || !isToday || !active || targetReached || !actions.checkIns || Boolean(busyAction)} onClick={() => void checkIn(day)}>{done ? "VERIFIED ✓" : targetReached ? "TARGET MET" : !active ? "CLOSED" : isToday ? busyAction ? "VERIFYING…" : "VERIFY" : day < currentDay ? "MISSED" : "LOCKED"}</button></div>;
            })}
          </div>
        </div>
        <details className="pact-details"><summary>LOCK DETAILS <span>+</span></summary><div className="details-body"><div><span>MISSION</span><b>{mission.name} · {targetLabel}</b></div>{pact[10] === DUOLINGO_XP_MISSION && isJoined && <div className="duolingo-inline"><span>DUOLINGO USERNAME</span><input value={duolingoUsername} onChange={(event) => setDuolingoUsername(event.target.value)} placeholder="your_username"/><small>Keep bio set to <code>{address ? duolingoOwnershipCode(address) : "LI-<YOUR WALLET CODE>"}</code></small></div>}<div><span>STAKE / PLAYER</span><b>{formatUnits(pact[2], decimals)} {symbol}</b></div><div><span>REGISTRATION CLOSES</span><b>{formatDate(startsAt)}</b></div><div><span>PROGRAM ENDS</span><b>{formatDate(endsAt)}</b></div><div><span>MINIMUM CREW</span><b>{minParticipants} players</b></div><div><span>FINISHERS</span><b>{pact[5]}</b></div></div></details>
      </section>

      <div className="pact-actions" id="join-lock">
        {isJoined && active && activityCode && <div className="proof-prep"><div><span>STRAVA RUN TITLE</span><code>{activityCode}</code><small>Use this exact title for today&apos;s GPS run.</small></div><button className="secondary-button" type="button" onClick={() => void copyProofValue(activityCode, "Run title")}>COPY TITLE</button></div>}
        {isJoined && pact[10] === DUOLINGO_XP_MISSION && ownershipCode && <div className="proof-prep"><div><span>DUOLINGO BIO CODE</span><code>{ownershipCode}</code><small>Keep this exact code in your public bio while the lock is active.</small></div><button className="secondary-button" type="button" onClick={() => void copyProofValue(ownershipCode, "Bio code")}>COPY CODE</button></div>}
        {!isJoined && registration && <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>}
        {!isJoined && registration && <button className="lock-button" disabled={!entryAccepted || !actions.join || Boolean(busyAction)} onClick={() => address ? setJoinReviewOpen(true) : setMessage("Connect your wallet to join.")}>JOIN FOR {formatUnits(pact[2], decimals)} {symbol}</button>}
        {!isJoined && registration && !actions.join && <p>Joining is temporarily paused for safety.</p>}
        {!isJoined && !registration && <p>Registration is closed.</p>}
        {isJoined && registration && address?.toLowerCase() === pact[0].toLowerCase() && !pact[14] && <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => void finalizeOrClaim("cancel")}>CANCEL BEFORE START</button>}
        {!pact[13] && canSettle && <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => void finalizeOrClaim("finalize")}>{pact[14] || underfilled ? "ENABLE REFUNDS" : "SETTLE LOCK"}</button>}
        {pact[13] && payoutEligible && !hasClaimed && <button className="lock-button" disabled={Boolean(busyAction)} onClick={() => void finalizeOrClaim("claim")}>{pact[14] || pact[5] === 0 ? "CLAIM MY REFUND" : "CLAIM MY PAYOUT"}</button>}
        {pact[13] && hasClaimed && <p>Your {pact[14] || pact[5] === 0 ? "refund" : "payout"} has already been claimed.</p>}
        {pact[13] && isJoined && !payoutEligible && <p>You missed the target, so your stake went to the finishers.</p>}
        {message && <p className="form-status" aria-live="polite">{message}{txHash && <> · <a href={`https://monadscan.com/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction ↗</a></>}</p>}
      </div>

      <ActionDialog open={joinReviewOpen} title="Join this lock?" eyebrow="Transaction review" confirmLabel={`Join for ${formatUnits(pact[2], decimals)} ${symbol}`} busy={Boolean(busyAction)} onClose={() => setJoinReviewOpen(false)} onConfirm={join}>
        <dl className="review-list"><div><dt>Mission</dt><dd>{mission.name} · {targetLabel}</dd></div><div><dt>Schedule</dt><dd>{requiredCompletions} of {durationDays} days</dd></div><div><dt>Starts</dt><dd>{formatDate(startsAt)}</dd></div><div><dt>Stake</dt><dd>{formatUnits(pact[2], decimals)} {symbol}</dd></div></dl>
        {pact[10] === DUOLINGO_XP_MISSION && <div className="duolingo-link"><label htmlFor="join-duolingo">Duolingo username</label><input id="join-duolingo" value={duolingoUsername} onChange={(event) => setDuolingoUsername(event.target.value)} placeholder="your_username"/><p>Set your bio to <code>{address ? duolingoOwnershipCode(address) : "LI-<YOUR WALLET CODE>"}</code> first.</p></div>}
        <p>Real USDC and gas are used on Monad mainnet. If the lock stays below two players, your stake is refundable.</p>
        <Link className="dialog-link" href="/rules">Read the rules ↗</Link>
      </ActionDialog>
    </main>
  );
}

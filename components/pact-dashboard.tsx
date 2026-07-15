"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatUnits, zeroAddress, type Address, type Hash } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, lockInAbi } from "@/src/lock-in-abi";
import { escrowAddress } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { dailyProofCode } from "@/src/pact-code";
import {
  createReclaimResumeSession,
  reclaimResumeStorageKey,
  validateReclaimResumeSession,
  type ReclaimResumeSession,
} from "@/src/reclaim-resume";
import { ActionDialog } from "@/components/action-dialog";
import { PactCrew } from "@/components/pact-crew";

type PactTuple = readonly [
  Address, bigint, bigint, bigint, number, number, number, number, number,
  number, number, Hash, Hash, bigint, boolean, boolean,
];

type ActiveProofFlow = {
  controller: AbortController;
  popup: Window | null;
  session: ReclaimResumeSession;
};

class TerminalReclaimError extends Error {}

function readStoredProofSession(pactId: string): unknown | null {
  const key = reclaimResumeStorageKey(pactId);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      window.sessionStorage.removeItem(key);
      return null;
    }
  } catch {
    return null;
  }
}

function storeProofSession(session: ReclaimResumeSession): boolean {
  try {
    window.sessionStorage.setItem(reclaimResumeStorageKey(session.pactId), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

function clearStoredProofSession(pactId: string, expectedToken?: string): void {
  try {
    const key = reclaimResumeStorageKey(pactId);
    if (expectedToken) {
      const stored = readStoredProofSession(pactId);
      if (
        stored &&
        typeof stored === "object" &&
        "token" in stored &&
        stored.token !== expectedToken
      ) return;
    }
    window.sessionStorage.removeItem(key);
  } catch {
    // sessionStorage can be unavailable in hardened/private browsing modes.
  }
}

function waitForPoll(signal: AbortSignal, delayMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    function abort() {
      window.clearTimeout(timer);
      reject(new DOMException("Proof verification cancelled", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function formatDate(seconds: bigint) {
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(Number(seconds) * 1_000);
}

export function PactDashboard({ id }: { id: string }) {
  const config = useConfig();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const pactId = /^\d+$/.test(id) ? BigInt(id) : 0n;
  const contract = escrowAddress || zeroAddress;
  const [message, setMessage] = useState("");
  const [busyDay, setBusyDay] = useState<number | null>(null);
  const [entryAccepted, setEntryAccepted] = useState(false);
  const [joinReviewOpen, setJoinReviewOpen] = useState(false);
  const [proofNoticeOpen, setProofNoticeOpen] = useState(false);
  const [pendingProofDay, setPendingProofDay] = useState<number | null>(null);
  const [proofNoticeSeen, setProofNoticeSeen] = useState(false);
  const [resumeSignal, setResumeSignal] = useState(0);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));
  const activeProofFlow = useRef<ActiveProofFlow | null>(null);
  const currentAddress = useRef<Address | undefined>(address);
  currentAddress.current = address;

  useEffect(() => {
    let alive = true;
    async function syncChainClock() {
      try {
        const block = await publicClient?.getBlock({ blockTag: "latest" });
        if (alive && block) setNowSeconds(Number(block.timestamp));
      } catch {
        if (alive) setNowSeconds(Math.floor(Date.now() / 1_000));
      }
    }
    void syncChainClock();
    const timer = window.setInterval(() => void syncChainClock(), 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [publicClient]);

  useEffect(() => {
    setProofNoticeSeen(window.sessionStorage.getItem("lock-in-proof-notice") === "seen");
  }, []);

  useEffect(() => {
    function resumeVisiblePage() {
      if (document.visibilityState === "visible") setResumeSignal((value) => value + 1);
    }
    window.addEventListener("pageshow", resumeVisiblePage);
    document.addEventListener("visibilitychange", resumeVisiblePage);
    return () => {
      window.removeEventListener("pageshow", resumeVisiblePage);
      document.removeEventListener("visibilitychange", resumeVisiblePage);
      const flow = activeProofFlow.current;
      activeProofFlow.current = null;
      flow?.controller.abort();
      flow?.popup?.close();
    };
  }, []);

  const reads = useReadContracts({
    contracts: [
      { address: contract, abi: lockInAbi, functionName: "pacts", args: [pactId] },
      { address: contract, abi: lockInAbi, functionName: "pactChallenges", args: [pactId] },
      { address: contract, abi: lockInAbi, functionName: "joined", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "completionBitmap", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "completionCount", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "claimed", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "stakeToken" },
    ],
    query: { enabled: Boolean(escrowAddress && pactId > 0n) },
  });
  const pact = reads.data?.[0]?.result as PactTuple | undefined;
  const challenge = (reads.data?.[1]?.result as string | undefined) || "";
  const isJoined = Boolean(reads.data?.[2]?.result);
  const bitmap = BigInt(reads.data?.[3]?.result || 0);
  const completed = Number(reads.data?.[4]?.result || 0);
  const hasClaimed = Boolean(reads.data?.[5]?.result);
  const token = (reads.data?.[6]?.result as Address | undefined) || zeroAddress;
  const tokenReads = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "allowance", args: [address || zeroAddress, contract] },
    ],
    query: { enabled: token !== zeroAddress && Boolean(address) },
  });
  const decimals = Number(tokenReads.data?.[0]?.result || 6);
  const symbol = String(tokenReads.data?.[1]?.result || "USDC");
  const allowance = BigInt(tokenReads.data?.[2]?.result || 0);

  const currentDay = useMemo(() => {
    if (!pact || nowSeconds < Number(pact[1])) return -1;
    return Math.min(pact[8], Math.floor((nowSeconds - Number(pact[1])) / 86_400));
  }, [nowSeconds, pact]);

  async function send(request: Parameters<typeof writeContractAsync>[0]) {
    if (!address || !publicClient) throw new Error("Wallet or Monad RPC unavailable");
    const estimate = await publicClient.estimateContractGas({
      ...request,
      account: address,
    } as never);
    const hash = await writeContractAsync({
      ...request,
      gas: addMonadGasBuffer(estimate),
    } as never);
    await waitForTransactionReceipt(config, { hash });
    await reads.refetch();
    await tokenReads.refetch();
    return hash;
  }

  async function join() {
    if (!address || !escrowAddress || !pact) return setMessage("Connect your wallet.");
    if (!entryAccepted) return setMessage("Accept the rules to continue.");
    setJoinReviewOpen(false);
    try {
      setMessage("Preparing your stake…");
      if (allowance < pact[3]) {
        await send({ address: token, abi: erc20Abi, functionName: "approve", args: [escrowAddress, pact[3]] });
      }
      setMessage("Joining the pact…");
      await send({ address: escrowAddress, abi: lockInAbi, functionName: "joinPact", args: [pactId] });
      setMessage("You are locked in. No excuses.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction rejected"); }
  }

  async function pollForProofs(session: ReclaimResumeSession, signal: AbortSignal): Promise<unknown> {
    let consecutiveFailures = 0;
    while (Date.now() < session.expiresAtMs) {
      if (signal.aborted) throw new DOMException("Proof verification cancelled", "AbortError");
      try {
        const response = await fetch("/api/reclaim/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: session.token }),
          signal,
        });
        const status = await response.json();
        if (!response.ok) {
          const reason = String(status.error || "Reclaim status unavailable");
          if (/expired|invalid proof session|malformed proof session/i.test(reason)) {
            throw new TerminalReclaimError(reason);
          }
          throw new Error(reason);
        }
        if (status.proofs) return status.proofs;
        const state = String(status.status || "");
        if (/FAILED|CANCELLED|CANCELED|EXPIRED/i.test(state)) {
          throw new TerminalReclaimError(`Reclaim: ${state}`);
        }
        consecutiveFailures = 0;
      } catch (error) {
        if (error instanceof TerminalReclaimError || (error instanceof DOMException && error.name === "AbortError")) throw error;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) throw error;
      }
      await waitForPoll(signal, Math.min(3_000, Math.max(1, session.expiresAtMs - Date.now())));
    }
    throw new TerminalReclaimError("The Reclaim proof expired");
  }

  async function runProofSession(session: ReclaimResumeSession, popup: Window | null, resumed = false) {
    const existing = activeProofFlow.current;
    if (existing) {
      if (existing.session.token === session.token) return;
      throw new Error("Another proof verification is already running");
    }
    const flow: ActiveProofFlow = { controller: new AbortController(), popup, session };
    activeProofFlow.current = flow;
    setBusyDay(session.dayIndex);
    try {
      setMessage(resumed ? "Resuming your Reclaim verification…" : `Set the day ${session.dayIndex + 1} Strava title, then confirm the proof.`);
      const proofs = await pollForProofs(session, flow.controller.signal);
      popup?.close();
      setMessage("Checking GPS, date, distance, and provider…");
      const verifyResponse = await fetch("/api/reclaim/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token, proofs }),
        signal: flow.controller.signal,
      });
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok) {
        const reason = String(verified.error || "Proof rejected");
        if (verifyResponse.status !== 429 && verifyResponse.status < 500) throw new TerminalReclaimError(reason);
        throw new Error(reason);
      }
      if (currentAddress.current?.toLowerCase() !== session.walletAddress.toLowerCase()) {
        throw new Error("Reconnect the wallet that started this proof, then try again.");
      }
      if (flow.controller.signal.aborted) throw new DOMException("Proof verification cancelled", "AbortError");
      setMessage("Valid proof. Recording the day on Monad…");
      await send({
        address: escrowAddress!,
        abi: lockInAbi,
        functionName: "submitStravaProofs",
        args: [
          pactId,
          session.dayIndex,
          session.challenge,
          verified.onchainProofs,
          BigInt(verified.attestation.expiresAt),
          verified.attestation.validatorSignature,
        ],
      } as never);
      clearStoredProofSession(session.pactId, session.token);
      setMessage(`Day ${session.dayIndex + 1} locked in ✓`);
    } catch (error) {
      popup?.close();
      if (error instanceof TerminalReclaimError) clearStoredProofSession(session.pactId, session.token);
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessage(error instanceof Error ? error.message : "Proof rejected");
      }
    } finally {
      if (activeProofFlow.current === flow) {
        activeProofFlow.current = null;
        setBusyDay(null);
      }
    }
  }

  async function prove(dayIndex: number) {
    if (!address || !escrowAddress || !pact) return setMessage("Connect your wallet.");
    const context = { pactId: pactId.toString(), walletAddress: address, challenge, durationDays: pact[8] };
    const stored = readStoredProofSession(context.pactId);
    if (stored) {
      const validation = validateReclaimResumeSession(stored, context);
      if (validation.ok && validation.session.dayIndex === dayIndex) {
        await runProofSession(validation.session, null, true);
        return;
      }
      clearStoredProofSession(context.pactId);
    }

    const popup = window.open("about:blank", "lock-in-reclaim", "popup,width=500,height=760");
    setBusyDay(dayIndex);
    try {
      setMessage("Creating the Reclaim session…");
      const sessionResponse = await fetch("/api/reclaim/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, pactId: context.pactId, dayIndex, challenge }),
      });
      const response = await sessionResponse.json();
      if (!sessionResponse.ok) throw new Error(response.error || "Reclaim session rejected");
      const session = createReclaimResumeSession({
        token: String(response.token || ""),
        sessionId: String(response.sessionId || ""),
        dayIndex,
        ...context,
      });
      if (!session) throw new Error("Reclaim returned an invalid proof session");
      const persisted = storeProofSession(session);
      let proofPopup = popup;
      if (proofPopup) {
        proofPopup.location.href = String(response.requestUrl);
      } else {
        if (!persisted) throw new Error("This browser cannot preserve the proof session. Enable session storage and try again.");
        window.location.assign(String(response.requestUrl));
      }
      await runProofSession(session, proofPopup);
    } catch (error) {
      popup?.close();
      setMessage(error instanceof Error ? error.message : "Proof rejected");
      setBusyDay(null);
    }
  }

  function requestProof(dayIndex: number) {
    if (proofNoticeSeen) {
      void prove(dayIndex);
      return;
    }
    setPendingProofDay(dayIndex);
    setProofNoticeOpen(true);
  }

  function continueToProof() {
    if (pendingProofDay === null) return;
    const day = pendingProofDay;
    window.sessionStorage.setItem("lock-in-proof-notice", "seen");
    setProofNoticeSeen(true);
    setProofNoticeOpen(false);
    setPendingProofDay(null);
    void prove(day);
  }

  useEffect(() => {
    if (!address || !pact || !challenge || !escrowAddress) return;
    const context = {
      pactId: pactId.toString(),
      walletAddress: address,
      challenge,
      durationDays: pact[8],
    };
    const stored = readStoredProofSession(context.pactId);
    if (!stored) return;
    const validation = validateReclaimResumeSession(stored, context);
    if (!validation.ok) {
      const flow = activeProofFlow.current;
      if (flow) {
        activeProofFlow.current = null;
        flow.controller.abort();
        flow.popup?.close();
      }
      clearStoredProofSession(context.pactId);
      setBusyDay(null);
      setMessage(validation.reason === "expired"
        ? "Your Reclaim proof session expired. Start verification again."
        : "Your saved Reclaim session no longer matches this pact and wallet. Start again.");
      return;
    }
    if ((bitmap & (1n << BigInt(validation.session.dayIndex))) !== 0n) {
      clearStoredProofSession(context.pactId, validation.session.token);
      setMessage(`Day ${validation.session.dayIndex + 1} is already verified.`);
      return;
    }
    void runProofSession(validation.session, null, true);
  }, [address, bitmap, challenge, pact, pactId, resumeSignal]);

  async function finalizeOrClaim(action: "finalize" | "claim") {
    if (!escrowAddress) return;
    try {
      setMessage(action === "finalize" ? "Settling the pact…" : "Claiming your payout…");
      await send({ address: escrowAddress, abi: lockInAbi, functionName: action === "finalize" ? "finalizePact" : "claim", args: [pactId] } as never);
      setMessage(action === "finalize" ? "Pact settled." : "Payout received.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction rejected"); }
  }

  async function sharePact() {
    const url = window.location.href;
    const inviteText = pact
      ? `Join my ${pact[4] / 1_000} km Lock In: ${pact[9]} runs in ${pact[8]} days, ${formatUnits(pact[3], decimals)} ${symbol} each.`
      : "Join my Lock In running challenge.";
    try {
      if (navigator.share) {
        await navigator.share({ title: `Lock In pact #${id}`, text: inviteText, url });
        setMessage("Invite ready to share.");
      } else {
        await navigator.clipboard.writeText(url);
        setMessage("Invite link copied.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        setMessage("Invite link copied.");
      } catch {
        setMessage("Copy the page URL to invite a friend.");
      }
    }
  }

  if (!escrowAddress) return <main className="pact-shell"><div className="empty-state"><strong>Lock In is not configured.</strong><Link href="/">Back home</Link></div></main>;
  if (pactId <= 0n) return <main className="pact-shell"><div className="empty-state"><strong>That pact ID is not valid.</strong><Link href="/#join">Find a crew</Link></div></main>;
  if (reads.isPending) return <main className="pact-shell"><div className="empty-state"><strong>Reading pact #{id} from Monad…</strong></div></main>;
  if (reads.isError) return <main className="pact-shell"><div className="empty-state"><strong>Monad is not responding.</strong><button className="secondary-button" onClick={() => reads.refetch()}>TRY AGAIN</button></div></main>;
  if (!pact || pact[0] === zeroAddress) return <main className="pact-shell"><div className="empty-state"><strong>Pact #{id} does not exist.</strong><Link href="/#join">Find a crew</Link></div></main>;

  const durationDays = pact[8];
  const requiredCompletions = pact[9];
  const minParticipants = pact[10];
  const endsAt = pact[1] + BigInt(durationDays * 86_400);
  const registration = nowSeconds < Number(pact[1]);
  const underfilled = !registration && pact[5] < minParticipants && !pact[14] && !pact[15];
  const active = !registration && nowSeconds < Number(endsAt) && !underfilled && !pact[14] && !pact[15];
  const grace = nowSeconds >= Number(endsAt) && nowSeconds <= Number(pact[2]) && !pact[14] && !pact[15];
  const canSettle = pact[15] || underfilled || nowSeconds > Number(pact[2]);
  const status = pact[15] ? (pact[14] ? "REFUNDS OPEN" : "CANCELLED") : pact[14] ? "SETTLED" : registration ? "REGISTRATION" : underfilled ? "UNDERFILLED" : active ? "ACTIVE" : grace ? "PROOF GRACE" : "SETTLEMENT READY";
  const targetReached = completed >= requiredCompletions;
  const payoutEligible = isJoined && (pact[15] || pact[6] === 0 || targetReached);
  const proofWindowOpen = !registration && nowSeconds <= Number(pact[2]) && !underfilled && !pact[14] && !pact[15] && !targetReached;
  const progress = Math.min(100, Math.round((completed / requiredCompletions) * 100));
  const displayedPool = pact[14] ? pact[13] : pact[3] * BigInt(pact[5]);
  const runnersNeeded = Math.max(0, minParticipants - pact[5]);
  const todayDone = currentDay >= 0 && currentDay < durationDays && (bitmap & (1n << BigInt(currentDay))) !== 0n;
  const canProveToday = currentDay >= 0 && currentDay < durationDays && isJoined && !todayDone && proofWindowOpen && busyDay === null;
  const roomHeading = registration
    ? runnersNeeded > 0 ? `${pact[5]} joined. ${runnersNeeded} more to start.` : "Your crew is ready."
    : targetReached ? "You kept the pact."
    : active && todayDone ? "Today is verified."
    : active ? `Run ${pact[4] / 1_000} km today.`
    : grace ? "Proof window still open."
    : status.replaceAll("_", " ");
  return (
    <main className="pact-shell">
      <div className="pact-topline"><Link href="/">← Home</Link><span>STRAVA RUN / #{id.padStart(4, "0")}</span><button type="button" onClick={sharePact}>SHARE ↗</button></div>
      <section className="pact-hero">
        <div><div className="live-pill"><i /> {status}</div><h1>{requiredCompletions} runs<br/><em>in {durationDays} days</em></h1><p>{pact[4] / 1_000} km each · {isJoined ? `${completed} verified` : `Starts ${formatDate(pact[1])}`}</p></div>
        <div className="pot"><span>{pact[14] ? "UNCLAIMED POOL" : "TOTAL POOL"}</span><strong>{formatUnits(displayedPool, decimals)}</strong><b>{symbol}</b><small>{pact[5]} player{pact[5] === 1 ? "" : "s"} · {minParticipants} needed</small></div>
      </section>
      <section className={`pact-now ${registration ? "forming" : active ? "active" : ""}`}>
        <div>
          <span>{registration ? "CREW CHECK" : active && currentDay >= 0 ? `TODAY · DAY ${currentDay + 1}` : "PACT STATUS"}</span>
          <h2>{roomHeading}</h2>
          {registration ? <p>Registration closes {formatDate(pact[1])}.</p> : canProveToday ? <p>Use <code>{dailyProofCode(challenge, currentDay)}</code> as the Strava activity title.</p> : active && todayDone ? <p>Your crew can see today&apos;s verified check.</p> : <p>{status === "SETTLED" ? "Payouts are ready." : `Proof deadline: ${formatDate(pact[2])}.`}</p>}
        </div>
        <div className="pact-now-actions">
          {registration && isJoined && <button className="lock-button" type="button" onClick={sharePact}>INVITE A RUNNER</button>}
          {registration && !isJoined && <a className="primary-link" href="#join-pact">JOIN THIS CREW</a>}
          {canProveToday && <button className="lock-button" type="button" onClick={() => requestProof(currentDay)}>VERIFY TODAY&apos;S RUN</button>}
          {!registration && isJoined && !canProveToday && <button className="secondary-button" type="button" onClick={sharePact}>SHARE PROGRESS</button>}
        </div>
      </section>
      <PactCrew pactId={pactId} participantCount={pact[5]} durationDays={durationDays} requiredCompletions={requiredCompletions} currentDay={currentDay} currentAddress={address}/>
      <section className="pact-grid">
        <div className="days-card">
          <div className="section-title"><span>{isJoined ? "YOUR RUN CALENDAR" : "RUN CALENDAR"}</span><b>{completed}/{requiredCompletions} REQUIRED</b></div>
          <div className="progress-track" role="progressbar" aria-label="Pact progress" aria-valuemin={0} aria-valuemax={requiredCompletions} aria-valuenow={completed}><i style={{ width: `${progress}%` }} /></div>
          <div className="day-list">
            {Array.from({ length: durationDays }, (_, day) => {
              const done = (bitmap & (1n << BigInt(day))) !== 0n;
              const dayState = done ? "done" : day === currentDay ? "today" : day < currentDay ? "past" : "upcoming";
              return <div className={`day-row ${dayState}`} key={day}><div><b>D{day + 1}</b>{isJoined && <code>{dailyProofCode(challenge, day)}</code>}<span>{formatDate(pact[1] + BigInt(day * 86_400))}</span></div><button disabled={!isJoined || done || !proofWindowOpen || busyDay !== null || day > currentDay} onClick={() => requestProof(day)}>{done ? "VERIFIED ✓" : targetReached ? "TARGET MET" : !proofWindowOpen ? "CLOSED" : busyDay === day ? "VERIFYING…" : day === currentDay ? "VERIFY TODAY" : day < currentDay ? "VERIFY RUN" : "LOCKED"}</button></div>;
            })}
          </div>
        </div>
        <details className="pact-details"><summary>PACT DETAILS <span>+</span></summary><div className="details-body"><div><span>STRAVA CODE PREFIX</span><code>{challenge}</code></div><div><span>STAKE / PERSON</span><b>{formatUnits(pact[3], decimals)} {symbol}</b></div><div><span>REGISTRATION CLOSES</span><b>{formatDate(pact[1])}</b></div><div><span>PROGRAM ENDS</span><b>{formatDate(endsAt)}</b></div><div><span>PROOF DEADLINE</span><b>{formatDate(pact[2])}</b></div><div><span>MINIMUM CREW</span><b>{minParticipants} participants</b></div><div><span>FINISHERS</span><b>{pact[6]}</b></div></div></details>
      </section>
      <div className="pact-actions" id="join-pact">
        {!isJoined && registration && <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>}
        {!isJoined && registration && <button className="lock-button" disabled={!entryAccepted} onClick={() => address ? setJoinReviewOpen(true) : setMessage("Connect your wallet to join.")}>JOIN FOR {formatUnits(pact[3], decimals)} {symbol}</button>}
        {!isJoined && !registration && <p>Registration is closed for this cohort.</p>}
        {isJoined && !pact[14] && canSettle && <button className="secondary-button" onClick={() => finalizeOrClaim("finalize")}>{underfilled ? "CANCEL & ENABLE REFUNDS" : "SETTLE PACT"}</button>}
        {pact[14] && payoutEligible && !hasClaimed && <button className="lock-button" onClick={() => finalizeOrClaim("claim")}>{pact[15] || pact[6] === 0 ? "CLAIM MY REFUND" : "CLAIM MY PAYOUT"}</button>}
        {pact[14] && hasClaimed && <p>Your payout has already been claimed.</p>}
        {pact[14] && isJoined && !payoutEligible && <p>The completion target was missed, so no payout is available.</p>}
        {message && <p className="form-status" aria-live="polite">{message}</p>}
      </div>
      <ActionDialog open={joinReviewOpen} title="Join this crew?" eyebrow="Transaction review" confirmLabel={`Join for ${formatUnits(pact[3], decimals)} ${symbol}`} onClose={() => setJoinReviewOpen(false)} onConfirm={join}>
        <p>Your wallet, participation, and stake transfer will be public and permanent on Monad. No Strava activity is published until you verify a run.</p>
        <Link className="dialog-link" href="/privacy">Privacy &amp; rights ↗</Link>
      </ActionDialog>
      <ActionDialog open={proofNoticeOpen} title="Before you publish your run" eyebrow="Strava verification" confirmLabel="Continue to Strava" onClose={() => { setProofNoticeOpen(false); setPendingProofDay(null); }} onConfirm={continueToProof}>
        <p>Your route and Strava login stay private. The public Monad record includes your wallet, a Strava account marker, activity ID and code, sport, date, distance, moving and elapsed time, elevation, and GPS, trainer, and flag checks. It cannot be deleted.</p>
        <Link className="dialog-link" href="/privacy">Privacy &amp; rights ↗</Link>
      </ActionDialog>
    </main>
  );
}

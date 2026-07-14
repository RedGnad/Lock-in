"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatUnits, zeroAddress, type Address, type Hash } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, lockInAbi } from "@/src/lock-in-abi";
import { escrowAddress } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { dailyProofCode } from "@/src/pact-code";

type PactTuple = readonly [
  Address, bigint, bigint, bigint, number, number, number, number, number,
  number, number, Hash, Hash, bigint, boolean, boolean,
];

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
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [entryAccepted, setEntryAccepted] = useState(false);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));

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

  async function prove(dayIndex: number) {
    if (!address || !escrowAddress) return setMessage("Connect your wallet.");
    if (!privacyAccepted) return setMessage("Review the proof disclosure first.");
    const popup = window.open("about:blank", "lock-in-reclaim", "popup,width=500,height=760");
    setBusyDay(dayIndex);
    try {
      setMessage("Creating the Reclaim session…");
      const sessionResponse = await fetch("/api/reclaim/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, pactId: id, dayIndex, challenge }),
      });
      const session = await sessionResponse.json();
      if (!sessionResponse.ok) throw new Error(session.error || "Reclaim session rejected");
      if (popup) popup.location.href = session.requestUrl;
      else window.location.href = session.requestUrl;
      setMessage(session.instruction || `Set the day ${dayIndex + 1} Strava title, then confirm the proof.`);

      let proofs: unknown = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const response = await fetch("/api/reclaim/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: session.token }),
        });
        const status = await response.json();
        if (!response.ok) throw new Error(status.error || "Reclaim status unavailable");
        if (status.proofs) { proofs = status.proofs; break; }
        if (/FAILED|CANCELLED/.test(status.status || "")) throw new Error(`Reclaim: ${status.status}`);
      }
      if (!proofs) throw new Error("The Reclaim proof expired");
      popup?.close();
      setMessage("Checking GPS, date, distance, and provider…");
      const verifyResponse = await fetch("/api/reclaim/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token, proofs }),
      });
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(verified.error || "Proof rejected");
      setMessage("Valid proof. Recording the day on Monad…");
      await send({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "submitStravaProofs",
        args: [
          pactId,
          dayIndex,
          challenge,
          verified.onchainProofs,
          BigInt(verified.attestation.expiresAt),
          verified.attestation.validatorSignature,
        ],
      } as never);
      setMessage(`Day ${dayIndex + 1} locked in ✓`);
    } catch (error) {
      popup?.close();
      setMessage(error instanceof Error ? error.message : "Proof rejected");
    } finally { setBusyDay(null); }
  }

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
    try {
      if (navigator.share) {
        await navigator.share({ title: `Lock In pact #${id}`, text: "Join my Strava running challenge.", url });
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

  if (!escrowAddress) return <main className="pact-shell"><div className="empty-state">Contract not configured.</div></main>;
  if (!pact || pact[0] === zeroAddress) return <main className="pact-shell"><div className="empty-state">Loading pact #{id}…</div></main>;

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
  return (
    <main className="pact-shell">
      <div className="pact-topline"><Link href="/">← Home</Link><span>STRAVA RUN / #{id.padStart(4, "0")}</span></div>
      <section className="pact-hero">
        <div><div className="live-pill"><i /> {status}</div><h1>{pact[4] / 1_000} km<br/><em>{requiredCompletions} of {durationDays} days</em></h1><p>Use the exact Strava code shown for each run. Finish the target before the proof deadline.</p></div>
        <div className="pot"><span>{pact[14] ? "UNCLAIMED POOL" : "TOTAL POOL"}</span><strong>{formatUnits(displayedPool, decimals)}</strong><b>{symbol}</b><small>{pact[5]} player{pact[5] === 1 ? "" : "s"} · {minParticipants} needed</small></div>
      </section>
      <section className="pact-grid">
        <div className="days-card">
          <div className="section-title"><span>YOUR PROGRESS</span><b>{completed}/{requiredCompletions} REQUIRED</b></div>
          <div className="progress-track" aria-label={`${progress}% complete`}><i style={{ width: `${progress}%` }} /></div>
          {isJoined && !targetReached && !pact[14] && !pact[15] && !underfilled && <label className="consent-row proof-consent"><input type="checkbox" checked={privacyAccepted} onChange={(event) => setPrivacyAccepted(event.target.checked)}/><span>Proof summary is public on Monad. Your GPS route is not shared. <Link href="/privacy">Privacy</Link></span></label>}
          <div className="day-list">
            {Array.from({ length: durationDays }, (_, day) => {
              const done = (bitmap & (1n << BigInt(day))) !== 0n;
              const dayState = done ? "done" : day === currentDay ? "today" : day < currentDay ? "past" : "upcoming";
              return <div className={`day-row ${dayState}`} key={day}><div><b>D{day + 1}</b><code>{dailyProofCode(challenge, day)}</code><span>{formatDate(pact[1] + BigInt(day * 86_400))}</span></div><button disabled={!isJoined || !privacyAccepted || done || !proofWindowOpen || busyDay !== null || day > currentDay} onClick={() => prove(day)}>{done ? "PROVED ✓" : targetReached ? "TARGET MET" : !proofWindowOpen ? "CLOSED" : busyDay === day ? "PROVING…" : day === currentDay ? "PROVE TODAY" : day < currentDay ? "PROVE RUN" : "LOCKED"}</button></div>;
            })}
          </div>
        </div>
        <aside className="pact-details"><div><span>STRAVA CODE PREFIX</span><code>{challenge}</code></div><div><span>STAKE / PERSON</span><b>{formatUnits(pact[3], decimals)} {symbol}</b></div><div><span>REGISTRATION CLOSES</span><b>{formatDate(pact[1])}</b></div><div><span>PROGRAM ENDS</span><b>{formatDate(endsAt)}</b></div><div><span>PROOF DEADLINE</span><b>{formatDate(pact[2])}</b></div><div><span>MINIMUM CREW</span><b>{minParticipants} participants</b></div><div><span>FINISHERS</span><b>{pact[6]}</b></div></aside>
      </section>
      <div className="pact-actions">
        {registration && <button className="secondary-button" onClick={sharePact}>INVITE A FRIEND</button>}
        {!isJoined && registration && <p className="proof-disclosure">Proof summary is public on Monad. Your GPS route is not shared. <Link href="/privacy">Privacy</Link></p>}
        {!isJoined && registration && <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>}
        {!isJoined && registration && <button className="lock-button" disabled={!entryAccepted} onClick={join}>JOIN FOR {formatUnits(pact[3], decimals)} {symbol}</button>}
        {!isJoined && !registration && <p>Registration is closed for this cohort.</p>}
        {isJoined && !pact[14] && canSettle && <button className="secondary-button" onClick={() => finalizeOrClaim("finalize")}>{underfilled ? "CANCEL & ENABLE REFUNDS" : "SETTLE PACT"}</button>}
        {pact[14] && payoutEligible && !hasClaimed && <button className="lock-button" onClick={() => finalizeOrClaim("claim")}>{pact[15] || pact[6] === 0 ? "CLAIM MY REFUND" : "CLAIM MY PAYOUT"}</button>}
        {pact[14] && hasClaimed && <p>Your payout has already been claimed.</p>}
        {pact[14] && isJoined && !payoutEligible && <p>The completion target was missed, so no payout is available.</p>}
        {message && <p className="form-status" aria-live="polite">{message}</p>}
      </div>
    </main>
  );
}

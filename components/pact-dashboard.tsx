"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatUnits, zeroAddress, type Address, type Hash } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, lockInAbi } from "@/src/lock-in-abi";
import { escrowAddress } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";

type PactTuple = readonly [
  Address, bigint, bigint, bigint, number, number, number, number, number,
  Hash, Hash, bigint, boolean, boolean,
];

function formatDate(seconds: bigint) {
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(Number(seconds) * 1_000);
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

  const reads = useReadContracts({
    contracts: [
      { address: contract, abi: lockInAbi, functionName: "pacts", args: [pactId] },
      { address: contract, abi: lockInAbi, functionName: "pactChallenges", args: [pactId] },
      { address: contract, abi: lockInAbi, functionName: "joined", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "completionBitmap", args: [pactId, address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "stakeToken" },
    ],
    query: { enabled: Boolean(escrowAddress && pactId > 0n) },
  });
  const pact = reads.data?.[0]?.result as PactTuple | undefined;
  const challenge = (reads.data?.[1]?.result as string | undefined) || "";
  const isJoined = Boolean(reads.data?.[2]?.result);
  const bitmap = Number(reads.data?.[3]?.result || 0);
  const token = (reads.data?.[4]?.result as Address | undefined) || zeroAddress;
  const tokenReads = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "allowance", args: [address || zeroAddress, contract] },
    ],
    query: { enabled: token !== zeroAddress && Boolean(address) },
  });
  const decimals = Number(tokenReads.data?.[0]?.result || 6);
  const symbol = String(tokenReads.data?.[1]?.result || "USD");
  const allowance = BigInt(tokenReads.data?.[2]?.result || 0);

  const currentDay = useMemo(() => {
    if (!pact) return 0;
    return Math.max(0, Math.min(pact[8] - 1, Math.floor((Date.now() / 1_000 - Number(pact[1])) / 86_400)));
  }, [pact]);

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
    if (!privacyAccepted) return setMessage("Accept the minimal Strava data processing first.");
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
      setMessage(`Connect Strava and confirm day ${dayIndex + 1}.`);

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

  if (!escrowAddress) return <main className="pact-shell"><div className="empty-state">Contract not configured.</div></main>;
  if (!pact || pact[0] === zeroAddress) return <main className="pact-shell"><div className="empty-state">Loading pact #{id}…</div></main>;

  const daysRequired = pact[8];
  const endsAt = pact[1] + BigInt(daysRequired * 86_400);
  return (
    <main className="pact-shell">
      <div className="pact-topline"><Link href="/">← All pacts</Link><span>PUBLIC PACT / #{id.padStart(4, "0")}</span></div>
      <section className="pact-hero">
        <div><div className="live-pill"><i /> {pact[12] ? "SETTLED" : pact[13] ? "REFUNDED" : "LIVE"}</div><h1>{pact[4] / 1_000} km<br/><em>× {daysRequired} day{daysRequired > 1 ? "s" : ""}</em></h1><p>Complete one run every day. Finishers split the entire pool.</p></div>
        <div className="pot"><span>CURRENT POOL</span><strong>{formatUnits(pact[3] * BigInt(pact[5]), decimals)}</strong><b>{symbol}</b><small>{pact[5]} participant{pact[5] > 1 ? "s" : ""}</small></div>
      </section>
      <section className="pact-grid">
        <div className="days-card">
          <div className="section-title"><span>PROGRESS</span><b>{bitmap.toString(2).split("1").length - 1}/{daysRequired}</b></div>
          <div className="day-list">
            {Array.from({ length: daysRequired }, (_, day) => {
              const done = (bitmap & (1 << day)) !== 0;
              return <div className={`day-row ${done ? "done" : ""}`} key={day}><div><b>D{day + 1}</b><span>{formatDate(pact[1] + BigInt(day * 86_400))}</span></div><button disabled={!isJoined || !privacyAccepted || done || busyDay !== null || day > currentDay} onClick={() => prove(day)}>{done ? "PROVED ✓" : busyDay === day ? "PROVING…" : "PROVE"}</button></div>;
            })}
          </div>
        </div>
        <aside className="pact-details"><div><span>STRAVA CODE</span><code>{challenge}</code></div><div><span>STAKE / PERSON</span><b>{formatUnits(pact[3], decimals)} {symbol}</b></div><div><span>PACT ENDS</span><b>{formatDate(endsAt)}</b></div><div><span>FINISHERS</span><b>{pact[6]}</b></div></aside>
      </section>
      <div className="pact-actions">
        {isJoined && !pact[12] && !pact[13] && <label className="consent-row"><input type="checkbox" checked={privacyAccepted} onChange={(event) => setPrivacyAccepted(event.target.checked)}/><span>I agree to the temporary processing of the Strava fields required for proof, as described in the <Link href="/privacy">privacy policy</Link>.</span></label>}
        {!isJoined && <button className="lock-button" onClick={join}>JOIN — {formatUnits(pact[3], decimals)} {symbol}</button>}
        {isJoined && !pact[12] && <button className="secondary-button" onClick={() => finalizeOrClaim("finalize")}>Settle after the deadline</button>}
        {pact[12] && <button className="lock-button" onClick={() => finalizeOrClaim("claim")}>CLAIM MY PAYOUT</button>}
        {message && <p>{message}</p>}
      </div>
    </main>
  );
}

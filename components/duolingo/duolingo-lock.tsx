"use client";

import { useState } from "react";
import { formatUnits, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useSignMessage } from "wagmi";
import { erc20Abi } from "@/src/lock-in-abi";
import { duolingoEscrowAddress } from "@/src/chain";
import { ShareSheet } from "@/components/share-sheet";
import {
  attestationIsFresh,
  joinPactArgs,
  parseBaselineEvidence,
  parseFinalEvidence,
  submitFinalArgs,
} from "@/src/duolingo-escrow-client";
import {
  escrowAbi,
  friendlyEscrowError,
  isRateLimited,
  RATE_LIMIT_MESSAGE,
  RECLAIM_NOTICE,
  runEscrowProof,
  useEscrowChain,
  useEscrowWrite,
  useNow,
} from "./escrow-shared";

const GRACE = 60 * 60;

function formatTime(seconds: number) {
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(seconds * 1_000);
}

export function DuolingoLock({ pactId, onLeave }: { pactId: string; onLeave: () => void }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const chain = useEscrowChain();
  const { writeWithGas } = useEscrowWrite();
  const now = useNow(15_000);

  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState<"join" | "final" | "settle" | "claim" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [passed, setPassed] = useState<{ earnedXp: number; targetXp: number } | null>(null);

  const id = /^[1-9]\d{0,29}$/.test(pactId) ? BigInt(pactId) : 0n;
  const enabled = Boolean(duolingoEscrowAddress) && id > 0n;
  const contract = (duolingoEscrowAddress || zeroAddress) as Address;
  const me = (address || zeroAddress) as Address;
  const query = { enabled, refetchInterval: 15_000 } as const;

  const { data: pact, refetch: refetchPact } = useReadContract({ address: contract, abi: escrowAbi, functionName: "getPact", args: [id], query });
  const { data: joined, refetch: refetchJoined } = useReadContract({ address: contract, abi: escrowAbi, functionName: "joined", args: [id, me], query });
  const { data: completed, refetch: refetchCompleted } = useReadContract({ address: contract, abi: escrowAbi, functionName: "completed", args: [id, me], query });
  const { data: claimedAlready, refetch: refetchClaimed } = useReadContract({ address: contract, abi: escrowAbi, functionName: "claimed", args: [id, me], query });

  function refreshAll() {
    void refetchPact(); void refetchJoined(); void refetchCompleted(); void refetchClaimed();
  }

  if (!enabled) return <div className="empty-state"><strong>That Lock could not be loaded.</strong></div>;
  if (!pact) return <div className="empty-state"><strong>Loading the Lock…</strong></div>;
  if (pact.creator === zeroAddress) return (
    <div className="empty-state"><strong>Lock #{pactId} does not exist.</strong>
      <button className="secondary-button" onClick={onLeave}>BACK</button></div>
  );

  const startsAt = Number(pact.startsAt);
  const endsAt = startsAt + Number(pact.durationSeconds);
  const deadline = endsAt + GRACE;
  const pool = pact.stake * BigInt(pact.participantCount);
  const stakeText = `${formatUnits(pact.stake, chain.decimals)} ${chain.symbol}`;
  const invite = typeof window !== "undefined" ? `${window.location.origin}/duolingo?lock=${pactId}` : "";
  const canTransact = chain.mode.canTransact && chain.chainOk;

  async function prove(intent: "join" | "final") {
    if (busy) return;
    setError(null); setNotice(null); setRateLimited(false);
    if (!address || !duolingoEscrowAddress) return setError("Connect your wallet first.");
    if (!canTransact) return setError("Duolingo staking is not open right now. Please try again later.");
    if (!username.trim()) return setError("Enter your Duolingo username.");
    setBusy(intent);
    const portal = window.open("", "_blank");
    let staked = false;
    try {
      const result = await runEscrowProof({
        address, signMessage: (message) => signMessageAsync({ message }), portal,
        sessionBody: { walletAddress: address, intent, username: username.trim(), pactId },
        onStatus: setStatus,
      });
      if (intent === "join") {
        if (result.phase !== "baseline" || !result.attestation) throw new Error("The baseline proof did not complete.");
        setStatus("BASELINE VERIFIED ✓");
        const baseline = parseBaselineEvidence(result.attestation);
        if (!attestationIsFresh(baseline.expiresAt)) throw new Error("Your proof expired. Prove your starting XP again.");
        if (chain.allowance < pact!.stake) {
          setStatus("APPROVING USDC…");
          await writeWithGas({ address: chain.token, abi: erc20Abi, functionName: "approve", args: [duolingoEscrowAddress, pact!.stake] }, "approval");
          chain.refetchAllowance();
        }
        if (!attestationIsFresh(baseline.expiresAt)) throw new Error("Your proof expired during approval. Prove your starting XP again.");
        setStatus("JOINING YOUR LOCK…");
        await writeWithGas({ address: duolingoEscrowAddress, abi: escrowAbi, functionName: "joinPact", args: joinPactArgs(id, baseline) }, "join");
        staked = true; // the stake has moved on-chain from here on
      } else {
        if (result.phase !== "final" || !result.attestation) throw new Error("The final proof did not complete.");
        setStatus("PUBLISHING YOUR RESULT…");
        const evidence = parseFinalEvidence(result.attestation);
        if (!attestationIsFresh(evidence.expiresAt)) throw new Error("Your proof expired. Verify your final XP again.");
        await writeWithGas({ address: duolingoEscrowAddress, abi: escrowAbi, functionName: "submitFinal", args: submitFinalArgs(id, evidence) }, "final");
        setPassed({ earnedXp: result.earnedXp ?? evidence.earnedXp, targetXp: result.targetXp ?? evidence.targetXp });
      }
      setStatus(null);
      refreshAll();
    } catch (caught) {
      portal?.close();
      setStatus(null);
      const message = caught instanceof Error ? caught.message : String(caught);
      // A short final is not an error the athlete caused: show the shortfall factually and let them retry.
      if (/Earned \d+ XP of the \d+/.test(message)) setNotice(`You earned ${message.match(/Earned (\d+) XP of the (\d+)/)?.[1]} of ${message.match(/of the (\d+)/)?.[1]} XP. Keep going and verify again before the deadline.`);
      else if (isRateLimited(caught)) setRateLimited(true);
      // The stake only moves once joinPact succeeds; before that, reassure that nothing was staked.
      else setError(friendlyEscrowError(caught) + (intent === "join" && !staked ? " No USDC has moved." : ""));
    } finally {
      setBusy(null);
    }
  }

  async function settle() {
    if (busy || !duolingoEscrowAddress) return;
    setBusy("settle"); setError(null);
    try {
      setStatus("SETTLING THE LOCK…");
      await writeWithGas({ address: duolingoEscrowAddress, abi: escrowAbi, functionName: "finalizePact", args: [id] }, "settle");
      setStatus(null); refreshAll();
    } catch (caught) { setStatus(null); setError(friendlyEscrowError(caught)); } finally { setBusy(null); }
  }

  async function claim() {
    if (busy || !duolingoEscrowAddress) return;
    setBusy("claim"); setError(null);
    try {
      setStatus("CLAIMING…");
      await writeWithGas({ address: duolingoEscrowAddress, abi: escrowAbi, functionName: "claim", args: [id] }, "claim");
      setStatus(null); refreshAll();
    } catch (caught) { setStatus(null); setError(friendlyEscrowError(caught)); } finally { setBusy(null); }
  }

  const beforeStart = now < startsAt;
  const duringChallenge = now >= startsAt && now < endsAt;
  const pastDeadline = now >= deadline;
  const refundMode = pact.cancelled || pact.finisherCount === 0;
  const eligibleToClaim = pact.finalized && !claimedAlready && (refundMode ? Boolean(joined) : Boolean(completed));

  return (
    <div className="duo-financial">
      <div className="duo-baseline">
        <div><span>TARGET</span><b>+{pact.targetXp} XP</b></div>
        <div><span>STAKE</span><b>{stakeText}</b></div>
        <div><span>POOL</span><b>{formatUnits(pool, chain.decimals)} {chain.symbol}</b></div>
        <div><span>CREW</span><b>{pact.participantCount} / {pact.maxParticipants}</b></div>
        <div><span>{beforeStart ? "STARTS" : "ENDS"}</span><b>{formatTime(beforeStart ? startsAt : endsAt)}</b></div>
        <div><span>YOU</span><b>{completed ? "Finished ✓" : joined ? "Joined" : "Not in"}</b></div>
      </div>

      {(beforeStart && !joined) || (duringChallenge && joined && !completed) ? (
        <div className="duo-step">
          <label htmlFor="duo-lock-username"><b>Your Duolingo username</b></label>
          <input id="duo-lock-username" className="invite-link" value={username} placeholder="RedGnad"
            onChange={(event) => setUsername(event.target.value)} disabled={Boolean(busy)} />
          <small>{RECLAIM_NOTICE}</small>
        </div>
      ) : null}

      {beforeStart && !joined && !pact.cancelled && !pact.finalized && pact.participantCount < pact.maxParticipants && (
        <button className="lock-button" disabled={Boolean(busy) || !canTransact} onClick={() => void prove("join")}>
          {busy === "join" ? (status ?? "WORKING…") : `PROVE XP & JOIN · ${stakeText}`}
        </button>
      )}

      {beforeStart && (
        <div className="duo-step">
          <div className="duo-invite-head">
            <b>Invite your crew</b>
            <ShareSheet url={invite} text={`I put ${formatUnits(pact.stake, chain.decimals)} USDC behind a ${pact.targetXp} XP Duolingo goal. Join my Lock.`} title={`Lock In · Duolingo #${pactId}`} />
          </div>
          <input className="invite-link" readOnly value={invite} onFocus={(event) => event.currentTarget.select()} />
          <small>They open this link, prove their starting XP, and stake the same {stakeText}.</small>
        </div>
      )}

      {duringChallenge && joined && !completed && (
        <>
          <p className="proof-disclosure">Earn {pact.targetXp} XP, then verify your final XP before {formatTime(endsAt)}.</p>
          <button className="lock-button" disabled={Boolean(busy) || !canTransact} onClick={() => void prove("final")}>
            {busy === "final" ? (status ?? "CHECKING YOUR PROGRESS…") : "VERIFY FINAL XP"}
          </button>
        </>
      )}

      {(completed || passed) && (
        <div className="duo-result"><strong>TARGET REACHED ✓</strong>
          {passed && <p>You earned <b>{passed.earnedXp} XP</b> against a target of {passed.targetXp}.</p>}</div>
      )}

      {now >= endsAt && !pact.finalized && (
        pastDeadline
          ? <button className="lock-button" disabled={Boolean(busy)} onClick={() => void settle()}>{busy === "settle" ? "SETTLING…" : "SETTLE LOCK"}</button>
          : <p className="form-status" role="status">The challenge has ended. Settlement opens at {formatTime(deadline)}.</p>
      )}

      {pact.finalized && (
        claimedAlready
          ? <p className="form-status" role="status">You have claimed this Lock.</p>
          : eligibleToClaim
            ? <button className="lock-button" disabled={Boolean(busy)} onClick={() => void claim()}>{busy === "claim" ? "CLAIMING…" : refundMode ? "CLAIM REFUND" : "CLAIM PAYOUT"}</button>
            : joined
              ? <p className="form-status" role="status">This Lock is settled. You did not reach the target, so there is nothing to claim.</p>
              : <p className="form-status" role="status">This Lock is settled.</p>
      )}

      {status && busy && <p className="form-status" aria-live="polite">{status}</p>}
      {notice && <p className="form-status" role="status">{notice}</p>}
      {rateLimited && (
        <div className="duo-notice" role="status">
          <strong>Just a moment</strong>
          <p>{RATE_LIMIT_MESSAGE} No USDC has moved, and your Lock is unchanged.</p>
          <button className="secondary-button" type="button" onClick={() => setRateLimited(false)}>TRY AGAIN LATER</button>
        </div>
      )}
      {error && <p className="form-status duo-error" role="alert">{error}</p>}

      <button className="secondary-button" disabled={Boolean(busy)} onClick={onLeave}>BACK TO DUOLINGO XP</button>
    </div>
  );
}

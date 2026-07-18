"use client";

import { useState } from "react";
import { formatUnits, parseEventLogs, type PublicClient } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { erc20Abi } from "@/src/lock-in-abi";
import { duolingoEscrowAddress } from "@/src/chain";
import {
  attestationIsFresh,
  createPactArgs,
  parseBaselineEvidence,
} from "@/src/duolingo-escrow-client";
import {
  escrowAbi,
  friendlyEscrowError,
  isRateLimited,
  RATE_LIMIT_MESSAGE,
  RECLAIM_NOTICE,
  runEscrowProof,
  stakeOptions,
  useEscrowChain,
  useEscrowWrite,
  useMemoStake,
} from "./escrow-shared";

const XP_TARGETS = [50, 100, 300, 500] as const;
const DURATIONS = [
  { label: "90 min", seconds: 90 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const;
const CREWS = [2, 4, 8] as const;
const JOIN_WINDOW = 30n * 60n;

async function scheduledStart(client: PublicClient): Promise<bigint> {
  const block = await client.getBlock({ blockTag: "latest" });
  const five = 5n * 60n;
  const earliest = block.timestamp + JOIN_WINDOW;
  return ((earliest + five - 1n) / five) * five;
}

export function DuolingoCreate({ onCreated }: { onCreated: (pactId: string) => void }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const chain = useEscrowChain();
  const { writeWithGas, publicClient } = useEscrowWrite();

  const [username, setUsername] = useState("");
  const [targetXp, setTargetXp] = useState<number>(100);
  const [durationSeconds, setDurationSeconds] = useState<number>(DURATIONS[0].seconds);
  const [maxParticipants, setMaxParticipants] = useState<number>(2);
  const [stakeInput, setStakeInput] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  const amount = useMemoStake(stakeInput, chain.decimals);
  const canTransact = chain.mode.canTransact;

  async function create() {
    if (busy) return;
    setError(null);
    setRateLimited(false);
    if (!address || !duolingoEscrowAddress || !publicClient) return setError("Connect your wallet first.");
    if (!canTransact) return setError("Duolingo staking is not open right now. Please try again later.");
    if (!chain.chainOk) return setError("Switch your wallet to Monad mainnet.");
    if (!username.trim()) return setError("Enter your Duolingo username.");
    if ((chain.minStake !== undefined && amount < chain.minStake) || (chain.maxStake !== undefined && amount > chain.maxStake)) {
      return setError("Choose a stake of 0.1, 0.5 or 1 USDC.");
    }
    if (chain.balance < amount) return setError(`You need ${stakeInput} ${chain.symbol} to create this Lock.`);

    setBusy(true);
    const portal = window.open("", "_blank");
    let staked = false;
    try {
      const startsAt = await scheduledStart(publicClient);
      const terms = {
        stake: amount.toString(),
        targetXp,
        durationSeconds,
        minParticipants: 2,
        maxParticipants,
        startsAt: Number(startsAt),
      };
      const result = await runEscrowProof({
        address,
        signMessage: (message) => signMessageAsync({ message }),
        portal,
        sessionBody: { walletAddress: address, intent: "create", username: username.trim(), ...terms },
        onStatus: setStatus,
      });
      if (result.phase !== "baseline" || !result.attestation || !result.createNonce) {
        throw new Error("The baseline proof did not complete.");
      }
      setStatus("BASELINE VERIFIED ✓");
      const baseline = parseBaselineEvidence(result.attestation);
      if (!attestationIsFresh(baseline.expiresAt)) throw new Error("Your proof expired. Prove your starting XP again.");

      if (chain.allowance < amount) {
        setStatus("APPROVING USDC…");
        await writeWithGas({ address: chain.token, abi: erc20Abi, functionName: "approve", args: [duolingoEscrowAddress, amount] }, "approval");
        chain.refetchAllowance();
      }
      // After the approve landed, the baseline may be near expiry: re-check before the second transaction.
      if (!attestationIsFresh(baseline.expiresAt)) throw new Error("Your proof expired during approval. Prove your starting XP again.");

      setStatus("CREATING YOUR LOCK…");
      const args = createPactArgs(
        { stake: amount, targetXp, durationSeconds, minParticipants: 2, maxParticipants, startsAt, createNonce: result.createNonce as `0x${string}` },
        baseline,
      );
      const hash = await writeWithGas({ address: duolingoEscrowAddress, abi: escrowAbi, functionName: "createPact", args }, "create");
      staked = true; // the stake has moved on-chain from here on
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const logs = parseEventLogs({ abi: escrowAbi, eventName: "PactCreated", logs: receipt.logs });
      const id = logs[0]?.args.pactId;
      if (id === undefined) throw new Error("Your Lock was created but its id could not be read. Check your wallet.");
      setStatus(null);
      onCreated(id.toString());
    } catch (caught) {
      portal?.close();
      setStatus(null);
      if (isRateLimited(caught)) setRateLimited(true);
      else setError(friendlyEscrowError(caught) + (staked ? "" : " No USDC has moved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="duo-financial">
      <div className="duo-proof-note">
        <strong>Secure proof required</strong>
        <span>Verify your XP at the start and finish. No permanent connection, and never your password.</span>
      </div>
      <div className="duo-step">
        <label htmlFor="duo-fin-username"><b>Your Duolingo username</b></label>
        <input id="duo-fin-username" className="invite-link" value={username} placeholder="RedGnad"
          onChange={(event) => setUsername(event.target.value)} disabled={busy} />
        <small>{RECLAIM_NOTICE}</small>
      </div>

      <div className="duo-step">
        <b>How much XP will you earn?</b>
        <div className="segmented">
          {XP_TARGETS.map((value) => (
            <button type="button" key={value} className={targetXp === value ? "active" : ""} aria-pressed={targetXp === value}
              disabled={busy} onClick={() => setTargetXp(value)}>{value}<small>XP</small></button>
          ))}
        </div>
        <small>Earn this much new XP before the deadline. It is a total, not a daily streak.</small>
      </div>

      <div className="duo-step">
        <b>How long?</b>
        <div className="segmented">
          {DURATIONS.map((option) => (
            <button type="button" key={option.seconds} className={durationSeconds === option.seconds ? "active" : ""}
              aria-pressed={durationSeconds === option.seconds} disabled={busy} onClick={() => setDurationSeconds(option.seconds)}>{option.label}</button>
          ))}
        </div>
      </div>

      <div className="duo-step">
        <b>Crew size</b>
        <div className="segmented">
          {CREWS.map((size) => (
            <button type="button" key={size} className={maxParticipants === size ? "active" : ""} aria-pressed={maxParticipants === size}
              disabled={busy} onClick={() => setMaxParticipants(size)}>{size}<small>MAX</small></button>
          ))}
        </div>
      </div>

      <div className="duo-step">
        <b>Your stake</b>
        <div className="segmented">
          {stakeOptions().map((value) => (
            <button type="button" key={value} className={stakeInput === value ? "active" : ""} aria-pressed={stakeInput === value}
              disabled={busy || !canTransact} onClick={() => setStakeInput(value)}>{value}<small>{chain.symbol}</small></button>
          ))}
        </div>
        {chain.minStake !== undefined && chain.maxStake !== undefined && (
          <small>From {formatUnits(chain.minStake, chain.decimals)} to {formatUnits(chain.maxStake, chain.decimals)} {chain.symbol}. Every player stakes the same.</small>
        )}
      </div>

      <button className="lock-button" disabled={busy || !canTransact} onClick={() => void create()}>
        {busy ? (status ?? "WORKING…") : `PROVE XP & CREATE · ${stakeInput} ${chain.symbol}`}
      </button>

      {!canTransact && chain.mode.status === "canary-paused" && (
        <p className="form-status safety-status" role="status">The financial canary is paused. Terms are visible; transactions are blocked.</p>
      )}
      {status && busy && <p className="form-status" aria-live="polite">{status}</p>}
      {rateLimited && (
        <div className="duo-notice" role="status">
          <strong>Just a moment</strong>
          <p>{RATE_LIMIT_MESSAGE} No USDC has moved, and your choices are kept.</p>
          <button className="secondary-button" type="button" onClick={() => setRateLimited(false)}>TRY AGAIN LATER</button>
        </div>
      )}
      {error && <p className="form-status duo-error" role="alert">{error}</p>}
    </div>
  );
}

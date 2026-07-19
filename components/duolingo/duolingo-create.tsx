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

/**
 * Native Duolingo creation, inside the shared "Build your lock" wizard. Mission is step 1 (chosen by the
 * host); this component owns step 2 (SET YOUR GOAL) and step 3 (STAKE & REVIEW). The proof, approve and
 * createPact logic in create() is unchanged from the standalone flow: only the layout is the wizard shell.
 */
export function DuolingoCreate({ onCreated, onBackToMission }: {
  onCreated: (pactId: string) => void;
  onBackToMission?: () => void;
}) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const chain = useEscrowChain();
  const { writeWithGas, publicClient } = useEscrowWrite();

  // step 0 = SET YOUR GOAL, step 1 = STAKE & REVIEW. Mission is the host's step, shown done in the track.
  const [step, setStep] = useState(0);
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
  const durationLabel = DURATIONS.find((option) => option.seconds === durationSeconds)?.label ?? "";

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

  const goalReady = Boolean(targetXp && durationSeconds && maxParticipants);

  return (
    <section className="create-card">
      <div className="create-heading">
        <div><span className="card-kicker">DUOLINGO XP · BETA</span><h2>Build your lock</h2></div>
        <span className="step-count">{step + 2} / 3</span>
      </div>
      <div className="step-track" aria-label={`Step ${step + 2} of 3`}>
        {[0, 1, 2].map((index) => (
          <button type="button" key={index} className={index <= step + 1 ? "active" : ""} disabled={busy || index > step + 1}
            onClick={() => { if (index === 0) onBackToMission?.(); else setStep(index - 1); }}
            aria-label={`Go to step ${index + 1}`} aria-current={index === step + 1 ? "step" : undefined} />
        ))}
      </div>

      <div className="form-stage">
        {step === 0 && (
          <fieldset className="form-field">
            <legend><b>Set your goal</b><span>Duolingo XP · pick a target, a window, and your crew.</span></legend>
            <div className="field-group">
              <span className="field-cap">Target XP</span>
              <div className="segmented target-options">
                {XP_TARGETS.map((value) => (
                  <button type="button" key={value} className={targetXp === value ? "active" : ""} aria-pressed={targetXp === value}
                    disabled={busy} onClick={() => setTargetXp(value)}>{value}<small>XP</small></button>
                ))}
              </div>
              <small>New XP to earn before the deadline. A total, not a daily streak.</small>
            </div>
            <div className="field-group">
              <span className="field-cap">Window</span>
              <div className="segmented schedule-options">
                {DURATIONS.map((option) => (
                  <button type="button" key={option.seconds} className={durationSeconds === option.seconds ? "active" : ""}
                    aria-pressed={durationSeconds === option.seconds} disabled={busy} onClick={() => setDurationSeconds(option.seconds)}>{option.label}</button>
                ))}
              </div>
            </div>
            <div className="field-group">
              <span className="field-cap">Crew</span>
              <div className="segmented crew-options" aria-label="Maximum crew size">
                {CREWS.map((size) => (
                  <button type="button" key={size} className={maxParticipants === size ? "active" : ""} aria-pressed={maxParticipants === size}
                    disabled={busy} onClick={() => setMaxParticipants(size)}>{size}<small>PLAYERS MAX</small></button>
                ))}
              </div>
            </div>
          </fieldset>
        )}

        {step === 1 && (
          <fieldset className="form-field">
            <legend><b>Stake &amp; review</b><span>Every player stakes the same amount.</span></legend>
            <div className="segmented stake-options">
              {stakeOptions().map((value) => (
                <button type="button" key={value} className={stakeInput === value ? "active" : ""} aria-pressed={stakeInput === value}
                  disabled={busy || !canTransact} onClick={() => setStakeInput(value)}>{value}<small>{chain.symbol}</small></button>
              ))}
            </div>
            <label htmlFor="duo-fin-username"><b>Your Duolingo username</b></label>
            <input id="duo-fin-username" className="invite-link" value={username} placeholder="RedGnad"
              onChange={(event) => setUsername(event.target.value)} disabled={busy} />
            <div className="duo-proof-note">
              <strong>Secure proof required</strong>
              <span>{RECLAIM_NOTICE}</span>
            </div>
          </fieldset>
        )}
      </div>

      <div className="pact-summary">
        <strong>Duolingo XP · +{targetXp} XP in {durationLabel}</strong>
        <span>up to {maxParticipants} players · {stakeInput} {chain.symbol} each</span>
      </div>

      <div className="stage-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={() => { if (step === 0) onBackToMission?.(); else setStep(0); }}>BACK</button>
        {step === 0
          ? <button className="lock-button" type="button" disabled={!goalReady} onClick={() => setStep(1)}>CONTINUE</button>
          : <button className="lock-button" type="button" disabled={busy || !canTransact} onClick={() => void create()}>{busy ? (status ?? "WORKING…") : `PROVE XP & CREATE · ${stakeInput} ${chain.symbol}`}</button>}
      </div>

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
    </section>
  );
}

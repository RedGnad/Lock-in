"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  formatUnits,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";
import {
  useAccount,
  useConfig,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, lockInAbi } from "@/src/lock-in-abi";
import { escrowAddress } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { STRAVA_TEMPLATES, stravaTemplate } from "@/src/missions";
import { ActionDialog } from "@/components/action-dialog";

const DISTANCES = ["1", "3", "5", "10"] as const;
const PUBLIC_TEMPLATES = STRAVA_TEMPLATES.filter((item) => item.publicCompetition);

function freshChallenge() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `LI-${Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").toUpperCase()}`;
}

function scheduledStart(durationDays: number, chainNowMs: number): bigint {
  const now = chainNowMs;
  if (durationDays === 1) return BigInt(Math.floor((now + 30 * 60 * 1_000) / 1_000));
  const minimum = new Date(now + 12 * 60 * 60 * 1_000);
  return BigInt(Math.floor(Date.UTC(
    minimum.getUTCFullYear(),
    minimum.getUTCMonth(),
    minimum.getUTCDate() + 1,
  ) / 1_000));
}

export function CreatePact() {
  const router = useRouter();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [distanceKm, setDistanceKm] = useState("1");
  const [durationDays, setDurationDays] = useState(3);
  const [stakeInput, setStakeInput] = useState("0.5");
  const [challenge, setChallenge] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [entryAccepted, setEntryAccepted] = useState(false);
  const [step, setStep] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);

  const contract = escrowAddress || zeroAddress;
  const { data: tokenAddress } = useReadContract({
    address: contract,
    abi: lockInAbi,
    functionName: "stakeToken",
    query: { enabled: Boolean(escrowAddress) },
  });
  const { data: maxStake } = useReadContract({
    address: contract,
    abi: lockInAbi,
    functionName: "maxStake",
    query: { enabled: Boolean(escrowAddress) },
  });
  const token = (tokenAddress || zeroAddress) as Address;
  const { data: decimals = 6 } = useReadContract({ address: token, abi: erc20Abi, functionName: "decimals", query: { enabled: token !== zeroAddress } });
  const { data: symbol = "USDC" } = useReadContract({ address: token, abi: erc20Abi, functionName: "symbol", query: { enabled: token !== zeroAddress } });
  const { data: allowance = 0n, refetch: refetchAllowance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address || zeroAddress, contract],
    query: { enabled: Boolean(address && escrowAddress && token !== zeroAddress) },
  });

  const amount = useMemo(() => {
    try { return parseUnits(stakeInput || "0", decimals); } catch { return 0n; }
  }, [stakeInput, decimals]);
  const template = useMemo(() => stravaTemplate(durationDays), [durationDays]);

  async function writeWithTightGas(request: Parameters<typeof writeContractAsync>[0]) {
    if (!address || !publicClient) throw new Error("Wallet or Monad RPC unavailable");
    const estimate = await publicClient.estimateContractGas({
      ...request,
      account: address,
    } as never);
    return writeContractAsync({
      ...request,
      gas: addMonadGasBuffer(estimate),
    } as never);
  }

  async function create() {
    if (!address || !escrowAddress || !publicClient) return setStatus("Connect your wallet and configure the contract.");
    if (!entryAccepted) return setStatus("Accept the rules to continue.");
    if (amount <= 0n || (maxStake && amount > maxStake)) return setStatus(`Enter a stake above 0 and no more than ${maxStake ? formatUnits(maxStake, decimals) : "1"} ${symbol}.`);
    const minDistance = Math.round(Number(distanceKm) * 1_000);
    if (!Number.isSafeInteger(minDistance) || minDistance <= 0) return setStatus("Invalid distance.");
    const pactChallenge = challenge || freshChallenge();
    setChallenge(pactChallenge);
    setReviewOpen(false);
    setBusy(true);
    try {
      if (allowance < amount) {
        setStatus(`Approving ${stakeInput} ${symbol}…`);
        const approveHash = await writeWithTightGas({ address: token, abi: erc20Abi, functionName: "approve", args: [escrowAddress, amount] });
        await waitForTransactionReceipt(config, { hash: approveHash });
        await refetchAllowance();
      }
      const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
      const startsAt = scheduledStart(durationDays, Number(latestBlock.timestamp) * 1_000);
      const claimDeadline = startsAt + BigInt(durationDays * 86_400 + 3_600);
      const minParticipants = durationDays === 1 ? 1 : 2;
      setStatus("Locking the pact on Monad…");
      const hash = await writeWithTightGas({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "createPact",
        args: [
          amount,
          minDistance,
          durationDays,
          template.requiredCompletions,
          minParticipants,
          startsAt,
          claimDeadline,
          pactChallenge,
        ],
      });
      const receipt = await waitForTransactionReceipt(config, { hash });
      const logs = parseEventLogs({ abi: lockInAbi, eventName: "PactCreated", logs: receipt.logs });
      const pactId = logs[0]?.args.pactId;
      if (pactId === undefined) throw new Error("PactCreated event not found");
      router.push(`/pact/${pactId}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Transaction rejected");
    } finally {
      setBusy(false);
    }
  }

  function review() {
    if (!address || !escrowAddress || !publicClient) return setStatus("Connect your wallet to create this pact.");
    if (!entryAccepted) return setStatus("Accept the rules to continue.");
    if (amount <= 0n || (maxStake && amount > maxStake)) return setStatus(`Choose a stake no higher than ${maxStake ? formatUnits(maxStake, decimals) : "1"} ${symbol}.`);
    setStatus("");
    setReviewOpen(true);
  }

  return (
    <section className="create-card" id="create">
      <div className="create-heading">
        <div><span className="card-kicker">Create a crew challenge</span><h2>Build your pact</h2></div>
        <span className="step-count">{step + 1} / 3</span>
      </div>
      <div className="step-track" aria-label={`Step ${step + 1} of 3`}>
        {[0, 1, 2].map((index) => <button type="button" key={index} className={index <= step ? "active" : ""} onClick={() => setStep(index)} aria-label={`Go to step ${index + 1}`} aria-current={index === step ? "step" : undefined}/>) }
      </div>
      <div className="form-stage">
        {step === 0 && <fieldset className="form-field">
          <legend><b>How far?</b><span>Distance for each qualifying run.</span></legend>
          <div className="segmented distance-options">{DISTANCES.map((value) => <button type="button" aria-pressed={distanceKm === value} className={distanceKm === value ? "active" : ""} onClick={() => setDistanceKm(value)} key={value}>{value}<small>KM</small></button>)}</div>
        </fieldset>}
        {step === 1 && <fieldset className="form-field">
          <legend><b>How long?</b><span>Consistency wins; extra distance does not change the payout.</span></legend>
          <div className="segmented schedule-options">{PUBLIC_TEMPLATES.map((item) => <button type="button" aria-pressed={durationDays === item.durationDays} className={durationDays === item.durationDays ? "active" : ""} onClick={() => setDurationDays(item.durationDays)} key={item.id}>{item.durationDays}<small>DAYS · {item.requiredCompletions} RUNS</small></button>)}</div>
        </fieldset>}
        {step === 2 && <fieldset className="form-field">
          <legend><b>Your stake</b><span>Every participant stakes the same amount.</span></legend>
          <div className="segmented stake-options">{["0.1", "0.5", "1"].map((value) => { const option = parseUnits(value, decimals); const unavailable = maxStake !== undefined && option > maxStake; return <button type="button" aria-pressed={stakeInput === value} className={stakeInput === value ? "active" : ""} disabled={unavailable} onClick={() => setStakeInput(value)} key={value}>{formatUnits(option, decimals)}<small>{symbol}</small></button>; })}</div>
        </fieldset>}
      </div>
      <div className="pact-summary"><strong>{template.requiredCompletions} runs in {durationDays} days</strong><span>{distanceKm} km each · {stakeInput} {symbol} each · 2+ runners</span></div>
      {step === 2 && <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>}
      <div className="stage-actions">
        {step > 0 && <button className="secondary-button" type="button" onClick={() => setStep((current) => current - 1)}>BACK</button>}
        {step < 2 ? <button className="lock-button" type="button" onClick={() => setStep((current) => current + 1)}>CONTINUE</button> : <button className="lock-button" onClick={review} disabled={busy || !escrowAddress || !entryAccepted}>REVIEW PACT</button>}
      </div>
      {status && <p className="form-status" aria-live="polite">{status}</p>}
      <ActionDialog open={reviewOpen} title="Lock in this pact?" eyebrow="Transaction review" confirmLabel={`Stake ${stakeInput} ${symbol} & create`} busy={busy} onClose={() => setReviewOpen(false)} onConfirm={create}>
        <dl className="review-list">
          <div><dt>Goal</dt><dd>{distanceKm} km · {template.requiredCompletions} runs / {durationDays} days</dd></div>
          <div><dt>Stake</dt><dd>{stakeInput} {symbol} per runner</dd></div>
          <div><dt>Start</dt><dd>Next UTC boundary after at least 12 hours</dd></div>
        </dl>
        <p>Lock In uses your wallet and pact details to run this challenge. This transaction is public and permanent on Monad. No Strava data is published when you create.</p>
        <Link className="dialog-link" href="/privacy">Privacy &amp; rights ↗</Link>
      </ActionDialog>
    </section>
  );
}

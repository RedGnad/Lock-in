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

  return (
    <section className="create-card" id="create">
      <div className="card-kicker">Create a running challenge</div>
      <div className="form-stack">
        <fieldset className="form-field">
          <legend>Distance</legend>
          <div className="segmented distance-options">{DISTANCES.map((value) => <button type="button" aria-pressed={distanceKm === value} className={distanceKm === value ? "active" : ""} onClick={() => setDistanceKm(value)} key={value}>{value}<small>KM</small></button>)}</div>
        </fieldset>
        <fieldset className="form-field">
          <legend>Schedule</legend>
          <div className="segmented schedule-options">{PUBLIC_TEMPLATES.map((item) => <button type="button" aria-pressed={durationDays === item.durationDays} className={durationDays === item.durationDays ? "active" : ""} onClick={() => setDurationDays(item.durationDays)} key={item.id}>{item.durationDays}<small>DAYS · {item.requiredCompletions} RUNS</small></button>)}</div>
        </fieldset>
        <fieldset className="form-field">
          <legend>Stake</legend>
          <div className="segmented stake-options">{["0.1", "0.5", "1"].map((value) => { const option = parseUnits(value, decimals); const unavailable = maxStake !== undefined && option > maxStake; return <button type="button" aria-pressed={stakeInput === value} className={stakeInput === value ? "active" : ""} disabled={unavailable} onClick={() => setStakeInput(value)} key={value}>{formatUnits(option, decimals)}<small>{symbol}</small></button>; })}</div>
        </fieldset>
      </div>
      <div className="pact-summary"><strong>{template.requiredCompletions} runs in {durationDays} days</strong><span>{distanceKm} km each · {stakeInput} {symbol} · starts in 12–36h · 2+ players</span></div>
      <p className="proof-disclosure">Proof summary is public on Monad. Your GPS route is not shared. <Link href="/privacy">Privacy</Link></p>
      <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>
      <button className="lock-button" onClick={create} disabled={busy || !escrowAddress || !entryAccepted}>{busy ? "CONFIRMING…" : `STAKE ${stakeInput} ${symbol} & CREATE`}</button>
      {status && <p className="form-status" aria-live="polite">{status}</p>}
    </section>
  );
}

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
    if (!entryAccepted) return setStatus("Accept the beta rules and public proof-data disclosure first.");
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
      <div className="card-kicker">New pact · Strava running</div>
      <div className="form-grid">
        <label><span>Distance per run</span><div className="input-unit"><input value={distanceKm} onChange={(event) => setDistanceKm(event.target.value)} inputMode="decimal"/><b>km</b></div></label>
        <label><span>Program</span><div className="segmented">{STRAVA_TEMPLATES.map((item) => <button type="button" className={durationDays === item.durationDays ? "active" : ""} onClick={() => setDurationDays(item.durationDays)} key={item.id}>{item.durationDays}d</button>)}</div><small>{template.name} · {template.requiredCompletions} run{template.requiredCompletions > 1 ? "s" : ""} required</small></label>
        <label><span>Symbolic stake</span><div className="segmented stake-options">{["0.1", "0.5", "1"].map((value) => { const option = parseUnits(value, decimals); const unavailable = maxStake !== undefined && option > maxStake; return <button type="button" aria-pressed={stakeInput === value} className={stakeInput === value ? "active" : ""} disabled={unavailable} onClick={() => setStakeInput(value)} key={value}>{formatUnits(option, decimals)}<small>{symbol}</small></button>; })}</div><small>Choose once—this beta cannot accept more than {maxStake !== undefined ? `${formatUnits(maxStake, decimals)} ${symbol}` : `1 ${symbol}`}.</small></label>
      </div>
      <div className="template-summary"><b>{template.name}</b><span>{template.description}</span><small>{durationDays === 1 ? "Starts in 30 minutes · practice/invite mode" : "Starts at a UTC day boundary after at least 12 hours of registration · 2 participants minimum"}</small><small>Creating the pact auto-joins your wallet. Token approval may add a second transaction; network gas is never refunded.</small></div>
      <div className="challenge-preview"><span>Daily code prefix</span><code>{challenge || "generated when you lock in"}</code></div>
      <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I am 18+, eligible where I live, and understand that the required Strava proof fields listed in the privacy notice—not my GPS route—will become public and permanent on Monad. <Link href="/rules">Rules</Link> · <Link href="/privacy">Privacy</Link></span></label>
      <button className="lock-button" onClick={create} disabled={busy || !escrowAddress || !entryAccepted}>{busy ? "Confirming…" : "LOCK IN →"}</button>
      {status && <p className="form-status">{status}</p>}
    </section>
  );
}

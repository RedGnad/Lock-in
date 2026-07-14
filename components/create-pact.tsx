"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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

function freshChallenge() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `LI-${Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").toUpperCase()}`;
}

export function CreatePact() {
  const router = useRouter();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [distanceKm, setDistanceKm] = useState("1");
  const [days, setDays] = useState(3);
  const [stakeInput, setStakeInput] = useState("1");
  const [challenge, setChallenge] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

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
  const { data: symbol = "USD" } = useReadContract({ address: token, abi: erc20Abi, functionName: "symbol", query: { enabled: token !== zeroAddress } });
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
    if (!address || !escrowAddress) return setStatus("Connect your wallet and configure the contract.");
    if (amount <= 0n || (maxStake && amount > maxStake)) return setStatus("The stake exceeds the onchain cap.");
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
      const startsAt = BigInt(Math.floor(Date.now() / 1_000) + 5 * 60);
      const claimDeadline = startsAt + BigInt(days * 86_400 + 3_600);
      setStatus("Locking the pact on Monad…");
      const hash = await writeWithTightGas({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "createPact",
        args: [amount, minDistance, days, startsAt, claimDeadline, pactChallenge],
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
        <label><span>Run each day</span><div className="input-unit"><input value={distanceKm} onChange={(event) => setDistanceKm(event.target.value)} inputMode="decimal"/><b>km</b></div></label>
        <label><span>Streak</span><div className="segmented">{[1, 2, 3, 4, 5].map((value) => <button type="button" className={days === value ? "active" : ""} onClick={() => setDays(value)} key={value}>{value}d</button>)}</div><small>3 days recommended · 1 day is for demos and practice</small></label>
        <label><span>Stake</span><div className="input-unit"><input value={stakeInput} onChange={(event) => setStakeInput(event.target.value)} inputMode="decimal"/><b>{symbol}</b></div><small>Contract cap: {maxStake !== undefined ? `${formatUnits(maxStake, decimals)} ${symbol}` : "—"}</small></label>
      </div>
      <div className="challenge-preview"><span>Run code</span><code>{challenge || "generated when you lock in"}</code></div>
      <button className="lock-button" onClick={create} disabled={busy || !escrowAddress}>{busy ? "Confirming…" : "LOCK IN →"}</button>
      {status && <p className="form-status">{status}</p>}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  formatUnits,
  keccak256,
  parseEventLogs,
  parseUnits,
  toBytes,
  zeroAddress,
  type Address,
  type Hash,
} from "viem";
import {
  useAccount,
  useChainId,
  useConfig,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, lockInAbi, MONAD_CHECK_IN_MISSION } from "@/src/lock-in-abi";
import { escrowAddress, monad } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { PACT_TEMPLATES, pactTemplate } from "@/src/missions";
import { ActionDialog } from "@/components/action-dialog";

const JOIN_WINDOW_SECONDS = 2 * 60 * 60;
type PendingCreate = { account: Address; action: "approval" | "create"; hash: Hash };

function scheduledStart(chainTimestamp: bigint): bigint {
  const earliest = chainTimestamp + BigInt(JOIN_WINDOW_SECONDS);
  const quarterHour = 15n * 60n;
  return ((earliest + quarterHour - 1n) / quarterHour) * quarterHour;
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|user denied|rejected the request/i.test(message)) return "Transaction cancelled.";
  if (/insufficient funds|exceeds balance/i.test(message)) return "You need more MON for network gas.";
  if (/CreationIsPaused/i.test(message)) return "New pacts are paused for safety.";
  if (/InvalidStake/i.test(message)) return "Choose a stake from 0.1 to 1 USDC.";
  if (/InvalidSchedule/i.test(message)) return "The join window expired. Review the pact again.";
  return "The transaction did not complete. Check your wallet and try again.";
}

function pendingKey(account: Address) {
  return `lock-in:pending-create:${account.toLowerCase()}`;
}

function savePending(account: Address, value: PendingCreate | null) {
  try {
    if (value) window.localStorage.setItem(pendingKey(account), JSON.stringify(value));
    else window.localStorage.removeItem(pendingKey(account));
  } catch {
    // Transaction safety still relies on the wallet when storage is unavailable.
  }
}

function readPending(account: Address): PendingCreate | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(pendingKey(account)) || "null") as PendingCreate | null;
    if (!parsed || !/^0x[0-9a-f]{64}$/i.test(parsed.hash) || !/^0x[0-9a-f]{40}$/i.test(parsed.account)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function CreatePact() {
  const router = useRouter();
  const config = useConfig();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [durationDays, setDurationDays] = useState(3);
  const [stakeInput, setStakeInput] = useState("0.1");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [entryAccepted, setEntryAccepted] = useState(false);
  const [step, setStep] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [creationEnabled, setCreationEnabled] = useState(false);

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
    functionName: "MAX_STAKE",
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
  const { data: tokenBalance = 0n } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address || zeroAddress],
    query: { enabled: Boolean(address && token !== zeroAddress), refetchInterval: 15_000 },
  });

  const amount = useMemo(() => {
    try { return parseUnits(stakeInput, decimals); } catch { return 0n; }
  }, [stakeInput, decimals]);
  const template = useMemo(() => pactTemplate(durationDays), [durationDays]);

  useEffect(() => {
    let alive = true;
    async function syncFlag() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const health = await response.json();
        if (alive) setCreationEnabled(Boolean(health.actions?.newPacts));
      } catch {
        if (alive) setCreationEnabled(false);
      }
    }
    void syncFlag();
    const timer = window.setInterval(() => void syncFlag(), 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!address) return;
    const pending = readPending(address);
    if (!pending || pending.account.toLowerCase() !== address.toLowerCase()) return;
    let alive = true;
    setBusy(true);
    busyRef.current = true;
    setStatus(`Recovering your ${pending.action} transaction…`);
    waitForTransactionReceipt(config, { hash: pending.hash, confirmations: 1 })
      .then((receipt) => {
        if (!alive) return;
        savePending(address, null);
        if (receipt.status !== "success") throw new Error("Transaction reverted");
        if (pending.action === "create") {
          const logs = parseEventLogs({ abi: lockInAbi, eventName: "PactCreated", logs: receipt.logs });
          const pactId = logs[0]?.args.pactId;
          if (pactId !== undefined) router.replace(`/pact/${pactId}`);
        } else {
          void refetchAllowance();
          setStatus("Approval confirmed. You can create the pact now.");
        }
      })
      .catch(() => setStatus("Your last transaction is still pending or failed. Check it in your wallet before retrying."))
      .finally(() => {
        if (alive) {
          setBusy(false);
          busyRef.current = false;
        }
      });
    return () => { alive = false; };
  }, [address, config, refetchAllowance, router]);

  async function writeWithGas(request: Parameters<typeof writeContractAsync>[0], action: PendingCreate["action"]) {
    if (!address || !publicClient) throw new Error("Wallet or Monad RPC unavailable");
    const estimate = await publicClient.estimateContractGas({ ...request, account: address } as never);
    const gas = addMonadGasBuffer(estimate);
    const [nativeBalance, gasPrice] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.getGasPrice(),
    ]);
    if (nativeBalance < gas * gasPrice) throw new Error("insufficient funds for gas");
    const hash = await writeContractAsync({ ...request, gas } as never);
    savePending(address, { account: address, action, hash });
    const receipt = await waitForTransactionReceipt(config, { hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error("Transaction reverted");
    savePending(address, null);
    return receipt;
  }

  async function create() {
    if (busyRef.current) return;
    if (!address || !escrowAddress || !publicClient) return setStatus("Connect your wallet first.");
    if (readPending(address)) return setStatus("A previous transaction is still pending. Check it in your wallet before retrying.");
    if (chainId !== monad.id) return setStatus("Switch your wallet to Monad mainnet.");
    if (!creationEnabled) return setStatus("New pacts are paused for safety.");
    if (!entryAccepted) return setStatus("Accept the Rules to continue.");
    if (amount <= 0n || (maxStake !== undefined && amount > maxStake)) return setStatus("Choose a stake from 0.1 to 1 USDC.");
    if (tokenBalance < amount) return setStatus(`You need ${stakeInput} ${symbol} to create this pact.`);

    setReviewOpen(false);
    setBusy(true);
    busyRef.current = true;
    try {
      if (allowance < amount) {
        setStatus(`Approve ${stakeInput} ${symbol} in your wallet…`);
        await writeWithGas({ address: token, abi: erc20Abi, functionName: "approve", args: [escrowAddress, amount] }, "approval");
        await refetchAllowance();
      }
      const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
      const startsAt = scheduledStart(latestBlock.timestamp);
      const missionConfigHash = keccak256(toBytes(`LOCK_IN:${template.id}:${template.requiredCompletions}/${template.durationDays}`));
      setStatus("Locking your pact on Monad…");
      const receipt = await writeWithGas({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "createPact",
        args: [amount, template.durationDays, template.requiredCompletions, 2, startsAt, MONAD_CHECK_IN_MISSION, missionConfigHash],
      }, "create");
      const logs = parseEventLogs({ abi: lockInAbi, eventName: "PactCreated", logs: receipt.logs });
      const pactId = logs[0]?.args.pactId;
      if (pactId === undefined) throw new Error("PactCreated event not found");
      router.push(`/pact/${pactId}`);
    } catch (error) {
      setStatus(friendlyError(error));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }

  function review() {
    if (!address) return setStatus("Connect your wallet to create a pact.");
    if (chainId !== monad.id) return setStatus("Switch your wallet to Monad mainnet.");
    if (!creationEnabled) return setStatus("New pacts are paused for safety.");
    if (!entryAccepted) return setStatus("Accept the Rules to continue.");
    if (tokenBalance < amount) return setStatus(`You need ${stakeInput} ${symbol} to create this pact.`);
    setStatus("");
    setReviewOpen(true);
  }

  return (
    <section className="create-card" id="create">
      <div className="create-heading">
        <div><span className="card-kicker">Create a crew challenge</span><h2>Build your pact</h2></div>
        <span className="step-count">{step + 1} / 2</span>
      </div>
      <div className="step-track" aria-label={`Step ${step + 1} of 2`}>
        {[0, 1].map((index) => <button type="button" key={index} className={index <= step ? "active" : ""} onClick={() => setStep(index)} aria-label={`Go to step ${index + 1}`} aria-current={index === step ? "step" : undefined}/>) }
      </div>
      <div className="form-stage">
        {step === 0 && <fieldset className="form-field">
          <legend><b>Pick your streak</b><span>Check in before the current 24-hour window closes.</span></legend>
          <div className="segmented schedule-options">{PACT_TEMPLATES.map((item) => <button type="button" aria-pressed={durationDays === item.durationDays} className={durationDays === item.durationDays ? "active" : ""} onClick={() => setDurationDays(item.durationDays)} key={item.id}>{item.durationDays}<small>DAYS · {item.requiredCompletions} CHECK-INS</small></button>)}</div>
        </fieldset>}
        {step === 1 && <fieldset className="form-field">
          <legend><b>Your stake</b><span>Every player stakes the same amount.</span></legend>
          <div className="segmented stake-options">{["0.1", "0.5", "1"].map((value) => { const option = parseUnits(value, decimals); const unavailable = maxStake !== undefined && option > maxStake; return <button type="button" aria-pressed={stakeInput === value} className={stakeInput === value ? "active" : ""} disabled={unavailable} onClick={() => setStakeInput(value)} key={value}>{formatUnits(option, decimals)}<small>{symbol}</small></button>; })}</div>
        </fieldset>}
      </div>
      <div className="pact-summary"><strong>{template.requiredCompletions} check-ins in {durationDays} days</strong><span>{stakeInput} {symbol} each · 2+ players · starts in about 2 hours</span></div>
      {step === 1 && <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>}
      <div className="stage-actions">
        {step > 0 && <button className="secondary-button" type="button" onClick={() => setStep(0)}>BACK</button>}
        {step === 0 ? <button className="lock-button" type="button" onClick={() => setStep(1)}>CONTINUE</button> : <button className="lock-button" onClick={review} disabled={busy || !escrowAddress || !entryAccepted || !creationEnabled}>REVIEW PACT</button>}
      </div>
      {!creationEnabled && <p className="form-status safety-status" role="status">New pacts are temporarily paused for safety.</p>}
      {status && <p className="form-status" aria-live="polite">{status}</p>}
      <ActionDialog open={reviewOpen} title="Lock in this pact?" eyebrow="Transaction review" confirmLabel={`Stake ${stakeInput} ${symbol} & create`} busy={busy} onClose={() => setReviewOpen(false)} onConfirm={create}>
        <dl className="review-list">
          <div><dt>Challenge</dt><dd>{template.requiredCompletions} check-ins / {template.durationDays} days</dd></div>
          <div><dt>Stake</dt><dd>{stakeInput} {symbol} per player</dd></div>
          <div><dt>Join window</dt><dd>About 2 hours</dd></div>
        </dl>
        <p>Real USDC and gas are used on Monad mainnet. This unaudited beta proves only a wallet check-in, which software can automate—not a real-world activity. The 1 USDC cap is per pact.</p>
        <Link className="dialog-link" href="/rules">Read the rules ↗</Link>
      </ActionDialog>
    </section>
  );
}

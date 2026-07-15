"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatUnits, parseEventLogs, parseUnits, zeroAddress, type Address, type Hash } from "viem";
import { useAccount, useChainId, useConfig, usePublicClient, useReadContract, useSignMessage, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import {
  DUOLINGO_XP_MISSION,
  emptyBaselineEvidence,
  emptyDirectProofBundle,
  erc20Abi,
  lockInAbi,
  type BaselineEvidence,
  type DirectProofBundle,
} from "@/src/lock-in-abi";
import { escrowAddress, monad } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";
import { MISSIONS, PACT_TEMPLATES, pactTemplate, type MissionId } from "@/src/missions";
import { openReclaimPopup, runReclaimProof } from "@/src/reclaim-client";
import { ensureWalletSession } from "@/src/wallet-auth-client";
import { requestAccessEvidence } from "@/src/access-client";
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
  if (/CreationIsPaused/i.test(message)) return "New locks are paused for safety.";
  if (/InvalidStake/i.test(message)) return "Choose a stake from 0.1 to 1 USDC.";
  if (/InvalidSchedule|next pact ID changed/i.test(message)) return "The join window changed. Review the lock again.";
  if (/popup/i.test(message)) return message;
  return message.length < 180 ? message : "The transaction did not complete. Check your wallet and try again.";
}

function pendingKey(account: Address) { return `lock-in:pending-create:${account.toLowerCase()}`; }
function savePending(account: Address, value: PendingCreate | null) {
  try {
    if (value) window.localStorage.setItem(pendingKey(account), JSON.stringify(value));
    else window.localStorage.removeItem(pendingKey(account));
  } catch {}
}
function readPending(account: Address): PendingCreate | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(pendingKey(account)) || "null") as PendingCreate | null;
    if (!parsed || !/^0x[0-9a-f]{64}$/i.test(parsed.hash) || !/^0x[0-9a-f]{40}$/i.test(parsed.account)) return null;
    return parsed;
  } catch { return null; }
}

export function CreatePact() {
  const router = useRouter();
  const config = useConfig();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const [missionId, setMissionId] = useState<MissionId>("strava");
  const [missionChosen, setMissionChosen] = useState(false);
  const [dailyTarget, setDailyTarget] = useState(3_000);
  const [durationDays, setDurationDays] = useState(3);
  const [maxParticipants, setMaxParticipants] = useState(4);
  const [stakeInput, setStakeInput] = useState("0.1");
  const [duolingoUsername, setDuolingoUsername] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [entryAccepted, setEntryAccepted] = useState(false);
  const [step, setStep] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [creationEnabled, setCreationEnabled] = useState(false);

  const contract = escrowAddress || zeroAddress;
  const { data: tokenAddress } = useReadContract({ address: contract, abi: lockInAbi, functionName: "stakeToken", query: { enabled: Boolean(escrowAddress) } });
  const { data: minStake } = useReadContract({ address: contract, abi: lockInAbi, functionName: "MIN_STAKE", query: { enabled: Boolean(escrowAddress) } });
  const { data: maxStake } = useReadContract({ address: contract, abi: lockInAbi, functionName: "MAX_STAKE", query: { enabled: Boolean(escrowAddress) } });
  const token = (tokenAddress || zeroAddress) as Address;
  const { data: decimals = 6 } = useReadContract({ address: token, abi: erc20Abi, functionName: "decimals", query: { enabled: token !== zeroAddress } });
  const { data: symbol = "USDC" } = useReadContract({ address: token, abi: erc20Abi, functionName: "symbol", query: { enabled: token !== zeroAddress } });
  const { data: allowance = 0n, refetch: refetchAllowance } = useReadContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [address || zeroAddress, contract],
    query: { enabled: Boolean(address && escrowAddress && token !== zeroAddress) },
  });
  const { data: tokenBalance = 0n } = useReadContract({
    address: token, abi: erc20Abi, functionName: "balanceOf", args: [address || zeroAddress],
    query: { enabled: Boolean(address && token !== zeroAddress), refetchInterval: 15_000 },
  });

  const amount = useMemo(() => { try { return parseUnits(stakeInput, decimals); } catch { return 0n; } }, [stakeInput, decimals]);
  const template = useMemo(() => pactTemplate(durationDays), [durationDays]);
  const mission = useMemo(() => MISSIONS.find((item) => item.id === missionId)!, [missionId]);

  useEffect(() => {
    let alive = true;
    async function syncFlag() {
      try {
        const health = await (await fetch("/api/health", { cache: "no-store" })).json();
        if (alive) setCreationEnabled(Boolean(health.actions?.newPacts));
      } catch { if (alive) setCreationEnabled(false); }
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
          const id = logs[0]?.args.pactId;
          if (id !== undefined) router.replace(`/lock/${id}`);
        } else {
          void refetchAllowance();
          setStatus("USDC approved. Review again to finish creating your lock.");
        }
      })
      .catch(() => setStatus("Your last transaction is still pending or failed. Check it in your wallet before retrying."))
      .finally(() => { if (alive) { setBusy(false); busyRef.current = false; } });
    return () => { alive = false; };
  }, [address, config, refetchAllowance, router]);

  async function writeWithGas(request: Parameters<typeof writeContractAsync>[0], action: PendingCreate["action"]) {
    if (!address || !publicClient) throw new Error("Wallet or Monad RPC unavailable");
    const estimate = await publicClient.estimateContractGas({ ...request, account: address } as never);
    const gas = addMonadGasBuffer(estimate);
    const [nativeBalance, gasPrice] = await Promise.all([publicClient.getBalance({ address }), publicClient.getGasPrice()]);
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
    if (readPending(address)) return setStatus("A previous transaction is still pending.");
    if (chainId !== monad.id) return setStatus("Switch your wallet to Monad mainnet.");
    if (!creationEnabled) return setStatus("New locks are paused for safety.");
    if (!entryAccepted) return setStatus("Accept the Rules to continue.");
    if ((minStake !== undefined && amount < minStake) || (maxStake !== undefined && amount > maxStake)) return setStatus("Choose a stake from 0.1 to 1 USDC.");
    if (tokenBalance < amount) return setStatus(`You need ${stakeInput} ${symbol} to create this lock.`);
    if (mission.type === DUOLINGO_XP_MISSION && !/^[A-Za-z0-9._-]{1,64}$/.test(duolingoUsername.trim())) {
      return setStatus("Enter your Duolingo username.");
    }

    setReviewOpen(false);
    setBusy(true);
    busyRef.current = true;
    let baseline: BaselineEvidence = emptyBaselineEvidence;
    let directProof: DirectProofBundle = emptyDirectProofBundle;
    let proofPopup: Window | null = null;
    try {
      if (allowance < amount) {
        setStatus(`Approve ${stakeInput} ${symbol} in your wallet…`);
        await writeWithGas({ address: token, abi: erc20Abi, functionName: "approve", args: [escrowAddress, amount] }, "approval");
        await refetchAllowance();
        if (mission.type === DUOLINGO_XP_MISSION) {
          setStatus("USDC approved. Review again to link Duolingo and create the lock.");
          return;
        }
      }

      if (mission.type === DUOLINGO_XP_MISSION) proofPopup = openReclaimPopup();
      setStatus("Checking secure wallet access…");
      await ensureWalletSession(address, (message) => signMessageAsync({ message }));
      if (mission.type === DUOLINGO_XP_MISSION) {
        const result = await runReclaimProof({
          walletAddress: address,
          pactId: "0",
          phase: "baseline",
          intent: "create",
          missionType: mission.type,
          username: duolingoUsername.trim(),
        }, setStatus, proofPopup);
        if (!result.baseline) throw new Error("Duolingo baseline was not returned");
        baseline = result.baseline;
        directProof = result.directProof;
      }

      const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
      const startsAt = scheduledStart(latestBlock.timestamp);
      const configuration = {
        stake: amount,
        dailyTarget,
        durationDays: template.durationDays,
        requiredCompletions: template.requiredCompletions,
        minParticipants: 2,
        maxParticipants,
        startsAt,
        missionType: mission.type,
      } as const;
      setStatus("Authorizing the reviewed lock…");
      const access = await requestAccessEvidence({
        walletAddress: address,
        action: "create",
        configuration,
      });
      setStatus("Creating your lock on Monad…");
      const receipt = await writeWithGas({
        address: escrowAddress,
        abi: lockInAbi,
        functionName: "createPact",
        args: [amount, dailyTarget, template.durationDays, template.requiredCompletions, 2, maxParticipants, startsAt, mission.type, baseline, directProof, access],
      }, "create");
      const logs = parseEventLogs({ abi: lockInAbi, eventName: "PactCreated", logs: receipt.logs });
      const id = logs[0]?.args.pactId;
      if (id === undefined) throw new Error("PactCreated event not found");
      router.push(`/lock/${id}`);
    } catch (error) {
      setStatus(friendlyError(error));
    } finally {
      baseline = emptyBaselineEvidence;
      directProof = emptyDirectProofBundle;
      if (proofPopup && !proofPopup.closed) proofPopup.close();
      setBusy(false);
      busyRef.current = false;
    }
  }

  function chooseMission(id: MissionId) {
    const next = MISSIONS.find((item) => item.id === id)!;
    setMissionId(id);
    setMissionChosen(true);
    setDailyTarget(next.defaultTarget);
    setStep(1);
  }

  function review() {
    if (!address) return setStatus("Connect your wallet to create a lock.");
    if (chainId !== monad.id) return setStatus("Switch your wallet to Monad mainnet.");
    if (!creationEnabled) return setStatus("New locks are paused for safety.");
    if (!entryAccepted) return setStatus("Accept the Rules to continue.");
    if ((minStake !== undefined && amount < minStake) || (maxStake !== undefined && amount > maxStake)) return setStatus("Choose a stake from 0.1 to 1 USDC.");
    if (tokenBalance < amount) return setStatus(`You need ${stakeInput} ${symbol} to create this lock.`);
    if (mission.type === DUOLINGO_XP_MISSION && !/^[A-Za-z0-9._-]{1,64}$/.test(duolingoUsername.trim())) return setStatus("Enter your Duolingo username.");
    setStatus("");
    setReviewOpen(true);
  }

  return (
    <section className="create-card" id="create">
      <div className="create-heading"><div><span className="card-kicker">CREATE A CHALLENGE</span><h2>Build your lock</h2></div><span className="step-count">{step + 1} / 3</span></div>
      <div className="step-track" aria-label={`Step ${step + 1} of 3`}>{[0, 1, 2].map((index) => <button type="button" key={index} className={index <= step ? "active" : ""} disabled={index > step} onClick={() => setStep(index)} aria-label={`Go to step ${index + 1}`} aria-current={index === step ? "step" : undefined}/>)}</div>
      <div className="form-stage">
        {step === 0 && <fieldset className="form-field"><legend><b>Choose your mission</b><span>Fitness or learning. Each has its own proof.</span></legend><div className="mission-options" role="group" aria-label="Mission">{MISSIONS.map((item) => { const selected = missionChosen && missionId === item.id; return <button type="button" className={selected ? "active" : ""} aria-pressed={selected} onClick={() => chooseMission(item.id)} key={item.id}><strong>{item.name}</strong><span>{item.description}</span></button>; })}</div></fieldset>}
        {step === 1 && <fieldset className="form-field"><legend><b>Set the pace</b><span>{mission.name} · choose a daily target, duration, and crew.</span></legend><div className="segmented target-options">{mission.targets.map((item) => <button type="button" className={dailyTarget === item.value ? "active" : ""} aria-pressed={dailyTarget === item.value} onClick={() => setDailyTarget(item.value)} key={item.value}>{item.label}</button>)}</div><div className="segmented schedule-options">{PACT_TEMPLATES.map((item) => <button type="button" className={durationDays === item.durationDays ? "active" : ""} aria-pressed={durationDays === item.durationDays} onClick={() => setDurationDays(item.durationDays)} key={item.id}>{item.durationDays}<small>DAYS · {item.requiredCompletions} WINS</small></button>)}</div><div className="segmented crew-options" aria-label="Maximum crew size">{[2, 4, 8].map((size) => <button type="button" className={maxParticipants === size ? "active" : ""} aria-pressed={maxParticipants === size} onClick={() => setMaxParticipants(size)} key={size}>{size}<small>PLAYERS MAX</small></button>)}</div>{mission.type === DUOLINGO_XP_MISSION && <div className="duolingo-link"><label htmlFor="duolingo-username">Duolingo username</label><input id="duolingo-username" value={duolingoUsername} onChange={(event) => setDuolingoUsername(event.target.value)} placeholder="your_username" autoComplete="off"/><p>Reclaim verifies that the signed-in Duolingo account owns this profile, then records a fresh XP baseline. Your name and game settings stay untouched.</p></div>}</fieldset>}
        {step === 2 && <fieldset className="form-field"><legend><b>Your stake</b><span>Every player stakes the same amount.</span></legend><div className="segmented stake-options">{["0.1", "0.5", "1"].map((value) => { const option = parseUnits(value, decimals); return <button type="button" className={stakeInput === value ? "active" : ""} aria-pressed={stakeInput === value} disabled={maxStake !== undefined && option > maxStake} onClick={() => setStakeInput(value)} key={value}>{formatUnits(option, decimals)}<small>{symbol}</small></button>; })}</div></fieldset>}
      </div>
      {step > 0 && <div className="pact-summary"><strong>{mission.name} · {template.requiredCompletions}/{durationDays} days</strong><span>{mission.targets.find((item) => item.value === dailyTarget)?.label} · up to {maxParticipants} players · {stakeInput} {symbol} each</span></div>}
      {step === 2 && <label className="consent-row"><input type="checkbox" checked={entryAccepted} onChange={(event) => setEntryAccepted(event.target.checked)}/><span>I&apos;m 18+ and accept the <Link href="/rules">Rules</Link>.</span></label>}
      {step > 0 && <div className="stage-actions"><button className="secondary-button" type="button" onClick={() => setStep((value) => value - 1)}>BACK</button>{step < 2 ? <button className="lock-button" type="button" onClick={() => setStep((value) => value + 1)}>CONTINUE</button> : <button className="lock-button" type="button" onClick={review} disabled={busy || !escrowAddress || !entryAccepted || !creationEnabled}>REVIEW LOCK</button>}</div>}
      {!creationEnabled && <p className="form-status safety-status" role="status">New locks are temporarily paused for safety.</p>}
      {status && <p className="form-status" aria-live="polite">{status}</p>}
      <ActionDialog open={reviewOpen} title="Create this lock?" eyebrow="Transaction review" confirmLabel={allowance < amount ? `Approve ${stakeInput} ${symbol}` : mission.type === DUOLINGO_XP_MISSION ? "Verify profile & create" : `Stake ${stakeInput} ${symbol} & create`} busy={busy} onClose={() => setReviewOpen(false)} onConfirm={create}>
        <dl className="review-list"><div><dt>Mission</dt><dd>{mission.name} · {mission.targets.find((item) => item.value === dailyTarget)?.label}</dd></div><div><dt>Schedule</dt><dd>{template.requiredCompletions} of {durationDays} days</dd></div><div><dt>Crew</dt><dd>2 required · {maxParticipants} maximum</dd></div><div><dt>Stake</dt><dd>{stakeInput} {symbol} per player</dd></div></dl>
        <p>{mission.type === DUOLINGO_XP_MISSION ? "Reclaim checks account ownership and current XP before any stake enters the lock. Only XP earned after that baseline can count." : "Each completion requires a challenge-named GPS run from the same Strava account. Suspicious, manual, trainer, flagged, or implausible runs are rejected."}</p>
        {mission.type === DUOLINGO_XP_MISSION && <p className="proof-disclosure"><strong>Public on Monad:</strong> verified Duolingo profile ID, XP, a non-sensitive ownership marker, proof time and standard Reclaim request metadata. Your username, password, cookies, email and privacy-setting values are excluded.</p>}
        <p>Wallet gas is separate. If fewer than two players join, each participant can reclaim their full stake.</p>
      </ActionDialog>
    </section>
  );
}

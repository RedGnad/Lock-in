"use client";

import { useEffect, useState, type FormEvent } from "react";
import { zeroAddress, type Hash } from "viem";
import { useAccount, useChainId, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { escrowAddress, monad } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";
import { addMonadGasBuffer } from "@/src/monad-gas";

const HANDLE_PATTERN = /^[a-z][a-z0-9_]{2,15}$/;

function profileError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|user denied|rejected the request/i.test(message)) return "Profile update cancelled.";
  if (/HandleAlreadyUsed/i.test(message)) return "That handle is already taken.";
  if (/InvalidHandle/i.test(message)) return "Use 3-16 lowercase letters, numbers, or underscores, starting with a letter.";
  if (/insufficient funds/i.test(message)) return "You need more MON for network gas.";
  return "The profile update did not complete. Try again after refreshing.";
}

export function PlayerProfile() {
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const contract = escrowAddress || zeroAddress;
  const [handle, setHandle] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState<Hash | null>(null);

  const reads = useReadContracts({
    contracts: [
      { address: contract, abi: lockInAbi, functionName: "playerHandle", args: [address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "lockScore", args: [address || zeroAddress] },
      { address: contract, abi: lockInAbi, functionName: "playerProfileHidden", args: [address || zeroAddress] },
    ],
    query: { enabled: Boolean(escrowAddress && address), refetchInterval: 30_000 },
  });
  const currentHandle = String(reads.data?.[0]?.result || "");
  const lockScore = BigInt(reads.data?.[1]?.result || 0);
  const profileHidden = Boolean(reads.data?.[2]?.result);

  useEffect(() => {
    if (!editing) setHandle(currentHandle);
  }, [currentHandle, editing]);

  useEffect(() => {
    setEditing(false);
    setHandle("");
    setMessage("");
    setTxHash(null);
  }, [address]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = handle.trim();
    if (!address) return setMessage("Connect your wallet to create a Lock In profile.");
    if (!escrowAddress || !publicClient) return setMessage("Profiles are not configured yet.");
    if (chainId !== monad.id) return setMessage("Switch your wallet to Monad mainnet.");
    if (!HANDLE_PATTERN.test(normalized)) return setMessage("Use 3-16 lowercase letters, numbers, or underscores, starting with a letter.");
    if (normalized === currentHandle) return setMessage("That is already your Lock In handle.");

    setBusy(true);
    setMessage("Confirm your profile on Monad…");
    setTxHash(null);
    try {
      const request = { address: escrowAddress, abi: lockInAbi, functionName: "setPlayerHandle" as const, args: [normalized] as const, account: address };
      const estimate = await publicClient.estimateContractGas(request);
      const hash = await writeContractAsync({ ...request, gas: addMonadGasBuffer(estimate) });
      setTxHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      await reads.refetch();
      setEditing(false);
      setMessage(`@${normalized} is now your Lock In handle.`);
    } catch (error) {
      setMessage(profileError(error));
    } finally {
      setBusy(false);
    }
  }

  async function clearHandle() {
    if (!address || !currentHandle) return;
    if (!escrowAddress || !publicClient) return setMessage("Profiles are not configured yet.");
    if (chainId !== monad.id) return setMessage("Switch your wallet to Monad mainnet.");

    setBusy(true);
    setMessage("Confirm removal on Monad…");
    setTxHash(null);
    try {
      const request = { address: escrowAddress, abi: lockInAbi, functionName: "clearPlayerHandle" as const, account: address };
      const estimate = await publicClient.estimateContractGas(request);
      const hash = await writeContractAsync({ ...request, gas: addMonadGasBuffer(estimate) });
      setTxHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      await reads.refetch();
      setHandle("");
      setEditing(false);
      setMessage("Your active Lock In handle was removed. Past onchain events remain public.");
    } catch (error) {
      setMessage(profileError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="player-profile" aria-labelledby="player-profile-title">
      <div className="player-profile-copy">
        <span>YOUR LOCK IN PROFILE</span>
        <h2 id="player-profile-title">{address ? currentHandle && !profileHidden ? `@${currentHandle}` : profileHidden ? "Handle hidden." : "Claim your name." : "Connect to join the board."}</h2>
        <p>This optional handle is only for Lock In leaderboards. It never changes your Strava name.</p>
      </div>
      <div className="profile-score"><strong>{address ? lockScore.toString() : "-"}</strong><span>ALL-TIME LOCK SCORE</span></div>
      {address && <form className="profile-form" onSubmit={save}>
        <label htmlFor="player-handle">{currentHandle ? "Change handle" : "Choose a handle"}</label>
        <div><span>@</span><input id="player-handle" value={handle} minLength={3} maxLength={16} pattern="[a-z][a-z0-9_]{2,15}" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="runner_one" disabled={busy} onFocus={() => setEditing(true)} onChange={(event) => { setEditing(true); setHandle(event.target.value.toLowerCase()); setMessage(""); }}/></div>
        <button className="secondary-button" type="submit" disabled={busy || !HANDLE_PATTERN.test(handle.trim()) || handle.trim() === currentHandle}>{busy ? "SAVING…" : currentHandle ? "UPDATE" : "CLAIM HANDLE"}</button>
        {currentHandle && <button className="profile-remove" type="button" disabled={busy} onClick={() => void clearHandle()}>REMOVE ACTIVE HANDLE</button>}
      </form>}
      {message && <p className="profile-message" aria-live="polite">{message}{txHash && <> · <a href={`https://monadscan.com/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction ↗</a></>}</p>}
    </section>
  );
}

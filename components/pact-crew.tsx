"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { zeroAddress, type Address } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";
import { escrowAddress, escrowDeploymentBlock } from "@/src/chain";
import { lockInAbi } from "@/src/lock-in-abi";

function compactAddress(address: Address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function avatarStyle(address: Address) {
  return { "--avatar-hue": String(Number.parseInt(address.slice(2, 8), 16) % 360) } as CSSProperties;
}

type PactCrewProps = {
  pactId: bigint;
  participantCount: number;
  durationDays: number;
  requiredCompletions: number;
  currentDay: number;
  currentAddress?: Address;
  highFiveBusy?: boolean;
  onHighFive?: (account: Address, dayIndex: number) => Promise<void>;
};

type HighFive = { from: Address; to: Address; dayIndex: number };

export function PactCrew({ pactId, participantCount, durationDays, requiredCompletions, currentDay, currentAddress, highFiveBusy = false, onHighFive }: PactCrewProps) {
  const publicClient = usePublicClient();
  const [members, setMembers] = useState<Address[]>([]);
  const [highFives, setHighFives] = useState<HighFive[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    async function loadCrew() {
      if (!publicClient || !escrowAddress) return;
      try {
        const [joinLogs, highFiveLogs] = await Promise.all([
          publicClient.getContractEvents({
            address: escrowAddress,
            abi: lockInAbi,
            eventName: "PactJoined",
            args: { pactId },
            fromBlock: escrowDeploymentBlock,
            toBlock: "latest",
          }),
          publicClient.getContractEvents({
            address: escrowAddress,
            abi: lockInAbi,
            eventName: "HighFiveSent",
            args: { pactId },
            fromBlock: escrowDeploymentBlock,
            toBlock: "latest",
          }),
        ]);
        const unique = Array.from(new Set(joinLogs.map((log) => log.args.account).filter(Boolean))) as Address[];
        const reactions = highFiveLogs.flatMap((log) => {
          const from = log.args.from;
          const to = log.args.to;
          const dayIndex = log.args.dayIndex;
          return from && to && dayIndex !== undefined ? [{ from, to, dayIndex: Number(dayIndex) }] : [];
        });
        if (alive) {
          setMembers(unique);
          setHighFives(reactions);
          setLoadError(false);
        }
      } catch {
        if (alive) setLoadError(true);
      }
    }
    void loadCrew();
    const timer = window.setInterval(() => void loadCrew(), 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pactId, publicClient]);

  const progressContracts = useMemo(() => members.flatMap((member) => [
    { address: escrowAddress || zeroAddress, abi: lockInAbi, functionName: "completionBitmap" as const, args: [pactId, member] as const },
    { address: escrowAddress || zeroAddress, abi: lockInAbi, functionName: "completionCount" as const, args: [pactId, member] as const },
    { address: escrowAddress || zeroAddress, abi: lockInAbi, functionName: "playerHandle" as const, args: [member] as const },
    { address: escrowAddress || zeroAddress, abi: lockInAbi, functionName: "playerProfileHidden" as const, args: [member] as const },
  ]), [members, pactId]);

  const progressReads = useReadContracts({
    contracts: progressContracts,
    query: { enabled: Boolean(escrowAddress && progressContracts.length), refetchInterval: 10_000 },
  });

  return (
    <section className="crew-card" aria-labelledby="crew-title">
      <div className="section-title"><span id="crew-title">CREW</span><b>{participantCount} PLAYER{participantCount === 1 ? "" : "S"}</b></div>
      {members.length > 0 ? <div className="crew-list">
        {members.map((member, index) => {
          const bitmap = BigInt(progressReads.data?.[index * 4]?.result || 0);
          const count = Number(progressReads.data?.[index * 4 + 1]?.result || 0);
          const handleResult = progressReads.data?.[index * 4 + 2]?.result;
          const profileHidden = Boolean(progressReads.data?.[index * 4 + 3]?.result);
          const handle = !profileHidden && typeof handleResult === "string" && handleResult ? `@${handleResult}` : "";
          const isYou = currentAddress?.toLowerCase() === member.toLowerCase();
          const received = highFives.filter((reaction) => reaction.to.toLowerCase() === member.toLowerCase()).length;
          const availableDay = Array.from({ length: durationDays }, (_, day) => durationDays - day - 1).find((day) => {
            if ((bitmap & (1n << BigInt(day))) === 0n || !currentAddress) return false;
            return !highFives.some((reaction) => reaction.from.toLowerCase() === currentAddress.toLowerCase()
              && reaction.to.toLowerCase() === member.toLowerCase() && reaction.dayIndex === day);
          });
          async function react() {
            if (!onHighFive || !currentAddress || availableDay === undefined) return;
            try {
              await onHighFive(member, availableDay);
              setHighFives((current) => [...current, { from: currentAddress, to: member, dayIndex: availableDay }]);
            } catch {
              // The lock page surfaces the wallet or contract error.
            }
          }
          return <article className="crew-member" key={member}>
            <span className="wallet-avatar" style={avatarStyle(member)} aria-hidden="true">{member.slice(2, 4).toUpperCase()}</span>
            <div className="crew-person"><strong>{isYou ? handle ? `You · ${handle}` : "You" : handle || compactAddress(member)}</strong><small>{count}/{requiredCompletions} check-ins{received > 0 ? ` · ${received} high five${received === 1 ? "" : "s"}` : ""}</small>{!isYou && currentAddress && count > 0 && <button className="high-five-button" type="button" disabled={highFiveBusy || availableDay === undefined} onClick={() => void react()}>{availableDay === undefined ? "HIGH FIVED" : `HIGH FIVE · D${availableDay + 1}`}</button>}</div>
            <div className="crew-days" aria-label={`${count} of ${requiredCompletions} check-ins completed`}>
              {Array.from({ length: durationDays }, (_, day) => {
                const complete = (bitmap & (1n << BigInt(day))) !== 0n;
                const state = complete ? "complete" : day === currentDay ? "today" : day < currentDay ? "missed" : "future";
                return <i className={state} key={day} title={`Day ${day + 1}: ${complete ? "verified" : state}`} />;
              })}
            </div>
          </article>;
        })}
      </div> : <div className="crew-loading">{loadError ? `${participantCount} player${participantCount === 1 ? "" : "s"} onchain · crew details unavailable` : "Reading the crew from Monad…"}</div>}
    </section>
  );
}

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
};

export function PactCrew({ pactId, participantCount, durationDays, requiredCompletions, currentDay, currentAddress }: PactCrewProps) {
  const publicClient = usePublicClient();
  const [members, setMembers] = useState<Address[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    async function loadCrew() {
      if (!publicClient || !escrowAddress) return;
      try {
        const logs = await publicClient.getContractEvents({
          address: escrowAddress,
          abi: lockInAbi,
          eventName: "PactJoined",
          args: { pactId },
          fromBlock: escrowDeploymentBlock,
          toBlock: "latest",
        });
        const unique = Array.from(new Set(logs.map((log) => log.args.account).filter(Boolean))) as Address[];
        if (alive) {
          setMembers(unique);
          setLoadError(false);
        }
      } catch {
        if (alive) setLoadError(true);
      }
    }
    void loadCrew();
    const timer = window.setInterval(() => void loadCrew(), 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pactId, publicClient]);

  const progressContracts = useMemo(() => members.flatMap((member) => [
    { address: escrowAddress || zeroAddress, abi: lockInAbi, functionName: "completionBitmap" as const, args: [pactId, member] as const },
    { address: escrowAddress || zeroAddress, abi: lockInAbi, functionName: "completionCount" as const, args: [pactId, member] as const },
  ]), [members, pactId]);

  const progressReads = useReadContracts({
    contracts: progressContracts,
    query: { enabled: Boolean(escrowAddress && progressContracts.length), refetchInterval: 30_000 },
  });

  return (
    <section className="crew-card" aria-labelledby="crew-title">
      <div className="section-title"><span id="crew-title">CREW</span><b>{participantCount} RUNNER{participantCount === 1 ? "" : "S"}</b></div>
      {members.length > 0 ? <div className="crew-list">
        {members.map((member, index) => {
          const bitmap = BigInt(progressReads.data?.[index * 2]?.result || 0);
          const count = Number(progressReads.data?.[index * 2 + 1]?.result || 0);
          const isYou = currentAddress?.toLowerCase() === member.toLowerCase();
          return <article className="crew-member" key={member}>
            <span className="wallet-avatar" style={avatarStyle(member)} aria-hidden="true">{member.slice(2, 4).toUpperCase()}</span>
            <div className="crew-person"><strong>{isYou ? "You" : compactAddress(member)}</strong><small>{count}/{requiredCompletions} runs</small></div>
            <div className="crew-days" aria-label={`${count} of ${requiredCompletions} runs completed`}>
              {Array.from({ length: durationDays }, (_, day) => {
                const complete = (bitmap & (1n << BigInt(day))) !== 0n;
                const state = complete ? "complete" : day === currentDay ? "today" : day < currentDay ? "missed" : "future";
                return <i className={state} key={day} title={`Day ${day + 1}: ${complete ? "verified" : state}`} />;
              })}
            </div>
          </article>;
        })}
      </div> : <div className="crew-loading">{loadError ? `${participantCount} runner${participantCount === 1 ? "" : "s"} onchain · crew details unavailable` : "Reading the crew from Monad…"}</div>}
    </section>
  );
}

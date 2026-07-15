"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatUnits, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { escrowAddress, escrowDeploymentBlock } from "@/src/chain";
import { lockInAbi, type PactTuple } from "@/src/lock-in-abi";
import { formatMissionTarget, missionByType } from "@/src/missions";

const DISCOVERY_LIMIT = 12;
type OpenPact = {
  id: bigint;
  pact: PactTuple;
};

function compactAddress(address: Address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatStart(seconds: bigint) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(Number(seconds) * 1_000);
}

export function PactDiscovery() {
  const router = useRouter();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const contract = escrowAddress || zeroAddress;
  const [pactIdInput, setPactIdInput] = useState("");
  const [inputError, setInputError] = useState("");
  const [nowSeconds, setNowSeconds] = useState<number | null>(null);
  const [myPactIds, setMyPactIds] = useState<bigint[]>([]);

  useEffect(() => {
    const syncClock = () => setNowSeconds(Math.floor(Date.now() / 1_000));
    syncClock();
    const timer = window.setInterval(syncClock, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    async function loadMyPacts() {
      if (!publicClient || !escrowAddress || !address) {
        if (alive) setMyPactIds([]);
        return;
      }
      try {
        const logs = await publicClient.getContractEvents({
          address: escrowAddress,
          abi: lockInAbi,
          eventName: "PactJoined",
          args: { account: address },
          fromBlock: escrowDeploymentBlock,
          toBlock: "latest",
        });
        const ids = Array.from(new Set(logs.map((log) => log.args.pactId).filter((id): id is bigint => id !== undefined))).sort((a, b) => a > b ? -1 : 1);
        if (alive) setMyPactIds(ids.slice(0, 6));
      } catch {
        if (alive) setMyPactIds([]);
      }
    }
    void loadMyPacts();
    const timer = window.setInterval(() => void loadMyPacts(), 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [address, publicClient]);

  const nextPact = useReadContract({
    address: contract,
    abi: lockInAbi,
    functionName: "nextPactId",
    query: {
      enabled: Boolean(escrowAddress),
      refetchInterval: 10_000,
    },
  });

  const nextPactId = nextPact.data;
  const recentPactIds = useMemo(() => {
    if (!nextPactId || nextPactId <= 1n) return [];
    const lastPactId = nextPactId - 1n;
    const count = Number(lastPactId < BigInt(DISCOVERY_LIMIT) ? lastPactId : BigInt(DISCOVERY_LIMIT));
    return Array.from({ length: count }, (_, index) => lastPactId - BigInt(index));
  }, [nextPactId]);

  const pactReads = useReadContracts({
    contracts: recentPactIds.map((id) => ({
      address: contract,
      abi: lockInAbi,
      functionName: "pacts",
      args: [id],
    })),
    query: {
      enabled: Boolean(escrowAddress && recentPactIds.length),
      refetchInterval: 10_000,
    },
  });

  const myPactReads = useReadContracts({
    contracts: myPactIds.map((id) => ({ address: contract, abi: lockInAbi, functionName: "pacts" as const, args: [id] as const })),
    query: { enabled: Boolean(escrowAddress && myPactIds.length), refetchInterval: 10_000 },
  });

  const openPacts = useMemo<OpenPact[]>(() => {
    if (nowSeconds === null) return [];

    return recentPactIds.flatMap((id, index) => {
      const pact = pactReads.data?.[index]?.result as PactTuple | undefined;
      if (
        !pact
        || pact[0] === zeroAddress
        || Number(pact[1]) <= nowSeconds
        || pact[4] >= pact[10]
        || pact[15]
        || pact[16]
      ) return [];

      return [{ id, pact }];
    });
  }, [nowSeconds, pactReads.data, recentPactIds]);

  function openPact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = pactIdInput.trim();
    if (!/^\d+$/.test(normalized) || BigInt(normalized) < 1n) {
      setInputError("Enter a valid Lock ID.");
      return;
    }

    const id = BigInt(normalized);
    if (nextPactId && id >= nextPactId) {
      setInputError("That lock does not exist yet.");
      return;
    }

    setInputError("");
    router.push(`/lock/${id}`);
  }

  const loading = nowSeconds === null || nextPact.isPending || (recentPactIds.length > 0 && pactReads.isPending);
  const failed = Boolean(nextPact.error || pactReads.error);

  return (
    <section className="pact-discovery" id="join" aria-labelledby="pact-discovery-title">
      <div className="discovery-heading">
        <div>
          <span className="card-kicker">OPEN LOCKS</span>
          <h2 id="pact-discovery-title">Join a crew</h2>
          <p>Browse challenges still forming, or open an invite by Lock ID.</p>
        </div>
        <form className="join-pact-form" onSubmit={openPact} noValidate>
          <label htmlFor="pact-id">Join by Lock ID</label>
          <div>
            <input
              id="pact-id"
              name="pactId"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="e.g. 12"
              value={pactIdInput}
              onChange={(event) => {
                setPactIdInput(event.target.value);
                if (inputError) setInputError("");
              }}
              aria-describedby={inputError ? "pact-id-error" : undefined}
              aria-invalid={Boolean(inputError)}
            />
            <button className="secondary-button" type="submit">OPEN LOCK</button>
          </div>
          {inputError && <small id="pact-id-error" role="alert">{inputError}</small>}
        </form>
      </div>

      {address && myPactIds.length > 0 && <section className="my-pacts" aria-labelledby="my-pacts-title">
        <div><span>WELCOME BACK</span><h3 id="my-pacts-title">Your locks</h3></div>
        <div className="my-pact-list">{myPactIds.map((id, index) => {
          const pact = myPactReads.data?.[index]?.result as PactTuple | undefined;
          if (!pact || pact[0] === zeroAddress) return null;
          const ended = nowSeconds !== null && nowSeconds >= Number(pact[1]) + pact[7] * 86_400;
          const state = pact[15] && pact[16] ? "REFUND READY" : pact[15] ? "SETTLED" : pact[16] ? "CANCELLED" : nowSeconds !== null && nowSeconds < Number(pact[1]) ? "FORMING" : ended ? "ENDING" : "ACTIVE";
          return <Link href={`/lock/${id}`} className="my-pact-row" key={id.toString()}><span>#{id.toString().padStart(4, "0")}</span><strong>{missionByType(pact[11]).name} · {pact[8]}/{pact[7]}</strong><b>{state} →</b></Link>;
        })}</div>
      </section>}

      {loading ? (
        <div className="discovery-state" aria-live="polite">Reading open challenges from Monad…</div>
      ) : failed ? (
        <div className="discovery-state" role="alert">Challenges could not be loaded. Try again shortly.</div>
      ) : openPacts.length === 0 ? (
        <div className="discovery-state discovery-empty">
          <p>No open challenges right now.</p>
        </div>
      ) : (
        <div className="discovery-grid">
          {openPacts.map(({ id, pact }) => {
            const playersNeeded = Math.max(0, pact[9] - pact[4]);
            const mission = missionByType(pact[11]);
            return (
              <Link className="discovery-card" href={`/lock/${id}`} key={id.toString()}>
                <div className="discovery-card-topline">
                  <span>LOCK #{id.toString().padStart(4, "0")}</span>
                  <b>REGISTRATION OPEN</b>
                </div>
                <h3>{mission.name}</h3>
                <p>{formatMissionTarget(pact[11], pact[3])} · {pact[8]} in {pact[7]} days</p>
                <dl>
                  <div><dt>Stake</dt><dd>{formatUnits(pact[2], 6)} USDC</dd></div>
                  <div><dt>Crew</dt><dd>{pact[4]}/{pact[10]} joined · {playersNeeded > 0 ? `${playersNeeded} needed` : "ready"}</dd></div>
                  <div><dt>Starts</dt><dd>{formatStart(pact[1])}</dd></div>
                </dl>
                <small>Created by {compactAddress(pact[0])} <b>→</b></small>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

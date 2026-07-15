"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatUnits, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { escrowAddress, escrowDeploymentBlock } from "@/src/chain";
import { lockInAbi, type PactTuple } from "@/src/lock-in-abi";

const DISCOVERY_LIMIT = 12;
const MAX_PARTICIPANTS = 100;

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
        || pact[3] >= MAX_PARTICIPANTS
        || pact[13]
        || pact[14]
      ) return [];

      return [{ id, pact }];
    });
  }, [nowSeconds, pactReads.data, recentPactIds]);

  function openPact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = pactIdInput.trim();
    if (!/^\d+$/.test(normalized) || BigInt(normalized) < 1n) {
      setInputError("Enter a valid pact ID.");
      return;
    }

    const id = BigInt(normalized);
    if (nextPactId && id >= nextPactId) {
      setInputError("That pact does not exist yet.");
      return;
    }

    setInputError("");
    router.push(`/pact/${id}`);
  }

  const loading = nowSeconds === null || nextPact.isPending || (recentPactIds.length > 0 && pactReads.isPending);
  const failed = Boolean(nextPact.error || pactReads.error);

  return (
    <section className="pact-discovery" id="join" aria-labelledby="pact-discovery-title">
      <div className="discovery-heading">
        <div>
          <span className="card-kicker">LIVE ON MONAD</span>
          <h2 id="pact-discovery-title">Join a crew</h2>
          <p>Find a real challenge with registration still open, or use an invite&apos;s pact ID.</p>
        </div>
        <form className="join-pact-form" onSubmit={openPact} noValidate>
          <label htmlFor="pact-id">Join by pact ID</label>
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
            <button className="secondary-button" type="submit">OPEN PACT</button>
          </div>
          {inputError && <small id="pact-id-error" role="alert">{inputError}</small>}
        </form>
      </div>

      {address && myPactIds.length > 0 && <section className="my-pacts" aria-labelledby="my-pacts-title">
        <div><span>WELCOME BACK</span><h3 id="my-pacts-title">Your pacts</h3></div>
        <div className="my-pact-list">{myPactIds.map((id, index) => {
          const pact = myPactReads.data?.[index]?.result as PactTuple | undefined;
          if (!pact || pact[0] === zeroAddress) return null;
          const ended = nowSeconds !== null && nowSeconds >= Number(pact[1]) + pact[6] * 86_400;
          const state = pact[13] && pact[14] ? "REFUND READY" : pact[13] ? "SETTLED" : pact[14] ? "CANCELLED" : nowSeconds !== null && nowSeconds < Number(pact[1]) ? "FORMING" : ended ? "ENDING" : "ACTIVE";
          return <Link href={`/pact/${id}`} className="my-pact-row" key={id.toString()}><span>#{id.toString().padStart(4, "0")}</span><strong>{pact[7]}/{pact[6]} day check-in</strong><b>{state} →</b></Link>;
        })}</div>
      </section>}

      {loading ? (
        <div className="discovery-state" aria-live="polite">Reading open challenges from Monad…</div>
      ) : failed ? (
        <div className="discovery-state" role="alert">Open challenges could not be loaded. You can still use a pact ID.</div>
      ) : openPacts.length === 0 ? (
        <div className="discovery-state discovery-empty">
          <p>No open challenges on Monad right now.</p>
          <a className="text-link" href="#create">Start the first crew <b>↘</b></a>
        </div>
      ) : (
        <div className="discovery-grid">
          {openPacts.map(({ id, pact }) => {
            const playersNeeded = Math.max(0, pact[8] - pact[3]);
            return (
              <Link className="discovery-card" href={`/pact/${id}`} key={id.toString()}>
                <div className="discovery-card-topline">
                  <span>PACT #{id.toString().padStart(4, "0")}</span>
                  <b>REGISTRATION OPEN</b>
                </div>
                <h3>{pact[7]} check-ins</h3>
                <p>in {pact[6]} days</p>
                <dl>
                  <div><dt>Stake</dt><dd>{formatUnits(pact[2], 6)} USDC</dd></div>
                  <div><dt>Crew</dt><dd>{pact[3]} joined · {playersNeeded > 0 ? `${playersNeeded} needed` : "ready"}</dd></div>
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

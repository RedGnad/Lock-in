"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { duolingoEscrowAddress } from "@/src/chain";
import { DuolingoPreview } from "@/components/duolingo-preview";
import { DuolingoCreate } from "@/components/duolingo/duolingo-create";
import { DuolingoLock } from "@/components/duolingo/duolingo-lock";
import { useEscrowChain } from "@/components/duolingo/escrow-shared";

/**
 * The Duolingo XP experience, in one of three modes decided by the chain, never by the browser:
 * - no escrow B address: the Live Proof Beta (zkTLS, no stake), with the stake selector shown but disabled;
 * - address present but paused, or the signer unverified: the financial canary, terms visible, writes off;
 * - address present, nothing paused, signer verified: live with USDC.
 *
 * A ?lock=<id> invite opens straight into that Lock, rendered with the same shell as a Strava Lock. When a
 * Lock is open there is no separate Beta chrome: leaving it returns to the home wizard, not a Duolingo page.
 */
export function DuolingoExperience({ initialLock }: { initialLock?: string }) {
  const router = useRouter();
  const { address } = useAccount();
  const chain = useEscrowChain();
  const [pactId, setPactId] = useState<string | null>(
    initialLock && /^[1-9]\d{0,29}$/.test(initialLock) ? initialLock : null,
  );
  const [openById, setOpenById] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const lock = new URLSearchParams(window.location.search).get("lock");
    if (lock && /^[1-9]\d{0,29}$/.test(lock)) setPactId(lock);
  }, []);

  const financial = Boolean(duolingoEscrowAddress);

  return (
    <div className="duo-experience">
      {!pactId && <div className="duo-mode-badge" data-mode={chain.mode.status}>{chain.mode.badge}</div>}

      {!financial && (
        <>
          <DuolingoPreview />
          <p className="proof-disclosure">
            Staked Locks with USDC are coming to Duolingo XP. For now this is a live proof: no stake, no
            escrow. The stake selector below is a preview of what is coming.
          </p>
          <div className="segmented" aria-hidden="true">
            {["0.1", "0.5", "1"].map((value) => (
              <button type="button" key={value} className="" disabled>{value}<small>USDC</small></button>
            ))}
          </div>
        </>
      )}

      {financial && !address && (
        <div className="empty-state"><strong>Connect your wallet to start.</strong>
          <p>Your Duolingo progress is proved against your wallet, and your stake is held in escrow on Monad.</p></div>
      )}

      {financial && address && pactId && (
        <DuolingoLock pactId={pactId} onLeave={() => router.push("/")} />
      )}

      {financial && address && !pactId && (
        <>
          <DuolingoCreate onCreated={(id) => router.push(`/duolingo?lock=${id}`)} />
          <div className="duo-step">
            <b>Have an invite?</b>
            <div className="join-by-id">
              <input className="invite-link" inputMode="numeric" placeholder="Lock number"
                value={openById} onChange={(event) => setOpenById(event.target.value.replace(/[^\d]/g, ""))} />
              <button className="secondary-button" disabled={!/^[1-9]\d{0,29}$/.test(openById)} onClick={() => setPactId(openById)}>OPEN</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

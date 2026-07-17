"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { ensureWalletSession } from "@/src/wallet-auth-client";

/**
 * Duolingo XP — Live Proof Beta.
 *
 * The athlete proves their starting XP, goes and learns, then proves their final XP. Lock In compares the
 * two and rules on the delta. No stake, no escrow, no USDC: this is the proof engine with a real journey
 * around it.
 *
 * Wording rule, and it is a promise rather than a style choice: this mission is CUMULATIVE. A delta
 * between two points proves the total moved and nothing about when, so it must never be sold as a streak
 * or as daily practice. "Earn 300 XP before the deadline", never "learn every day".
 *
 * TEE, providers and storage stay under the hood. The athlete is told what to do now and whether it worked.
 */

const XP_TARGETS = [50, 100, 300, 500] as const;
const POLL_MS = 4_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

type Run = {
  targetXp: number; baselineXp: number; baselineObservedAt: number;
  finalXp: number | null; earnedXp: number | null; finalObservedAt: number | null; passed: boolean | null;
};
type Result = { baselineXp: number; finalXp: number; earnedXp: number; targetXp: number };

function formatTime(seconds: number) {
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    .format(seconds * 1_000);
}

export function DuolingoPreview() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [username, setUsername] = useState("");
  const [targetXp, setTargetXp] = useState<number>(100);
  const [run, setRun] = useState<Run | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"baseline" | "final" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);

  const loadRun = useCallback(async (wallet: string) => {
    setLoadingRun(true);
    try {
      const response = await fetch(`/api/duolingo/run?wallet=${wallet}`, { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json();
      const loaded = response.ok ? payload.run : null;
      setRun(loaded);
      // A passing final is durable: coming back to the page shows the win, not just the baseline.
      if (loaded && loaded.passed) {
        setResult({ baselineXp: loaded.baselineXp, finalXp: loaded.finalXp, earnedXp: loaded.earnedXp, targetXp: loaded.targetXp });
      }
    } catch {
      setRun(null);
    } finally {
      setLoadingRun(false);
    }
  }, []);

  useEffect(() => {
    setResult(null);
    setRun(null);
    if (address) void loadRun(address);
  }, [address, loadRun]);

  /**
   * Opens the Reclaim portal and waits for the proof.
   *
   * The window is opened synchronously on the click, before any await: a popup opened after an await is
   * blocked by every browser, which on mobile looks exactly like the app doing nothing.
   */
  async function prove(phase: "baseline" | "final") {
    if (!address) return setError("Connect your wallet first.");
    if (!username.trim()) return setError("Enter your Duolingo username.");
    setBusy(phase);
    setError(null);
    setResult(null);
    const portal = window.open("", "_blank");
    try {
      // A signed session is required by every route below. Restore it before opening the portal so the
      // signature prompt does not land in the middle of the proof flow.
      setStatus("Securing your session…");
      await ensureWalletSession(address, (text) => signMessageAsync({ message: text }));
      setStatus("Opening the Duolingo proof…");
      const started = await fetch("/api/duolingo/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ walletAddress: address, phase, username: username.trim(), targetXp }),
      });
      const session = await started.json();
      if (!started.ok) throw new Error(session.error || "Could not start the proof");
      if (portal) portal.location.href = session.requestUrl;

      setStatus("Sign in to Duolingo in the new tab. Waiting for your proof…");
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const response = await fetch("/api/duolingo/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ sessionId: session.sessionId }),
        });
        const payload = await response.json();
        if (response.ok) {
          portal?.close();
          if (payload.phase === "baseline") {
            setStatus(null);
            await loadRun(address);
          } else {
            setStatus(null);
            setResult(payload as Result);
            await loadRun(address);
          }
          return;
        }
        // "not returned a proof yet" is the normal waiting state; anything else is a real refusal and the
        // athlete deserves the exact reason rather than a spinner that never ends.
        if (!/has not returned a proof yet/i.test(String(payload.error))) {
          throw new Error(payload.error || "The proof was rejected");
        }
        if (Date.now() > deadline) throw new Error("The proof timed out. Try again.");
      }
    } catch (caught) {
      portal?.close();
      setStatus(null);
      setError(caught instanceof Error ? caught.message : "The proof failed");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!address) return;
    await fetch(`/api/duolingo/run?wallet=${address}`, { method: "DELETE", credentials: "same-origin" });
    setRun(null);
    setResult(null);
    setError(null);
  }

  if (!address) {
    return <div className="empty-state"><strong>Connect your wallet to start.</strong>
      <p>Your Duolingo progress is proved against your wallet.</p></div>;
  }

  return (
    <div className="duo-preview">
      <div className="duo-step">
        <label htmlFor="duo-username"><b>Your Duolingo username</b></label>
        <input
          id="duo-username"
          className="invite-link"
          value={username}
          placeholder="RedGnad"
          onChange={(event) => setUsername(event.target.value)}
          disabled={Boolean(busy)}
        />
        <small>We look up your public profile. Lock In never receives your password. Reclaim may ask you to sign in securely.</small>
      </div>

      {!run && !loadingRun && (
        <>
          <div className="duo-step">
            <b>How much XP will you earn?</b>
            <div className="segmented">
              {XP_TARGETS.map((value) => (
                <button
                  type="button"
                  key={value}
                  className={targetXp === value ? "active" : ""}
                  aria-pressed={targetXp === value}
                  disabled={Boolean(busy)}
                  onClick={() => setTargetXp(value)}
                >{value}<small>XP</small></button>
              ))}
            </div>
            <small>Earn this much new XP before the deadline. It is a total, not a daily streak.</small>
          </div>
          <button className="lock-button" disabled={Boolean(busy)} onClick={() => void prove("baseline")}>
            {busy === "baseline" ? "PROVING…" : "VERIFY STARTING XP"}
          </button>
        </>
      )}

      {run && (
        <div className="duo-baseline">
          <div><span>STARTING XP</span><b>{run.baselineXp}</b></div>
          <div><span>TARGET</span><b>+{run.targetXp} XP</b></div>
          <div><span>PROVED AT</span><b>{formatTime(run.baselineObservedAt)}</b></div>
          <div><span>ACCOUNT</span><b>Duolingo verified ✓</b></div>
        </div>
      )}

      {run && !result && (
        <>
          <p className="proof-disclosure">Now go and learn. Come back when you have earned {run.targetXp} XP and prove your progress.</p>
          <button className="lock-button" disabled={Boolean(busy)} onClick={() => void prove("final")}>
            {busy === "final" ? "PROVING…" : "VERIFY FINAL XP"}
          </button>
        </>
      )}

      {result && (
        <div className="duo-result">
          <strong>Challenge complete ✓</strong>
          <p>{result.baselineXp} → {result.finalXp}. You earned <b>{result.earnedXp} XP</b> against a target of {result.targetXp}.</p>
        </div>
      )}

      {status && <p className="form-status" aria-live="polite">{status}</p>}
      {error && <p className="form-status duo-error" role="alert">{error}</p>}

      {run && (
        <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void reset()}>
          START OVER
        </button>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  STRAVA_CALLBACK_MESSAGES,
  disconnectStrava,
  startStravaAuthorization,
  stravaConnection,
} from "@/src/strava-client";
import { ensureWalletSession, hasWalletSession } from "@/src/wallet-auth-client";

/**
 * Connect Strava once, then check in.
 *
 * The athlete authorises Lock In on Strava's own screen a single time. Every later check-in reuses the
 * stored refresh token, so there is no second login, nothing to install and nothing to rename. That is
 * the whole reason this path replaced zkTLS.
 *
 * Reading the connection state requires a wallet session, but must never demand a signature just to look
 * at the page: without one we show the connect button, and the signature happens when the athlete asks
 * for it.
 */

type State = "loading" | "connected" | "disconnected";

export function StravaConnect({ onConnectedChange }: { onConnectedChange?: (connected: boolean) => void }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<State>("loading");
  const [athleteId, setAthleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const report = useCallback((connected: boolean) => {
    setState(connected ? "connected" : "disconnected");
    onConnectedChange?.(connected);
  }, [onConnectedChange]);

  useEffect(() => {
    // What Strava sent the athlete back with. Read once, then removed, so a refresh does not replay it.
    const outcome = new URLSearchParams(window.location.search).get("strava");
    if (!outcome) return;
    setMessage(STRAVA_CALLBACK_MESSAGES[outcome] || STRAVA_CALLBACK_MESSAGES.failed);
    const url = new URL(window.location.href);
    url.searchParams.delete("strava");
    window.history.replaceState(null, "", url.toString());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function read() {
      if (!address) {
        setState("loading");
        setAthleteId(null);
        return;
      }
      setState("loading");
      if (!(await hasWalletSession(address))) {
        if (!cancelled) report(false);
        return;
      }
      try {
        const connection = await stravaConnection(address);
        if (cancelled) return;
        setAthleteId(connection.athleteId ?? null);
        report(connection.connected);
      } catch {
        if (!cancelled) report(false);
      }
    }
    void read();
    return () => {
      cancelled = true;
    };
  }, [address, report]);

  async function connect() {
    if (!address) return setMessage("Connect your wallet first.");
    setBusy(true);
    setMessage(null);
    try {
      await ensureWalletSession(address, (text) => signMessageAsync({ message: text }));
      // Leaves the page for Strava's consent screen and comes back to `/?strava=…`.
      await startStravaAuthorization(address);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start Strava authorization.");
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!address) return;
    setBusy(true);
    setMessage(null);
    try {
      await ensureWalletSession(address, (text) => signMessageAsync({ message: text }));
      await disconnectStrava(address);
      setAthleteId(null);
      report(false);
      setConfirmingDisconnect(false);
      setMessage("Strava disconnected. Your tokens are revoked and deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not disconnect Strava.");
    } finally {
      setBusy(false);
    }
  }

  if (!address) return null;

  return (
    <div className="strava-connect" aria-live="polite">
      <div className="strava-connect-body">
        <span className={`strava-dot ${state === "connected" ? "on" : "off"}`} aria-hidden="true" />
        <div>
          <b>{state === "loading" ? "Checking Strava…" : state === "connected" ? "Strava connected" : "Connect Strava"}</b>
          <small>
            {state === "connected"
              ? `Athlete ${athleteId ?? "linked"}. We read only the run you check in, never your route.`
              : "One authorization on Strava. After that, checking in is a single tap."}
          </small>
        </div>
      </div>

      {state === "disconnected" && (
        <button type="button" className="lock-button" disabled={busy} onClick={() => void connect()}>
          {busy ? "OPENING STRAVA…" : "CONNECT STRAVA"}
        </button>
      )}

      {state === "connected" && !confirmingDisconnect && (
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>
          DISCONNECT
        </button>
      )}

      {state === "connected" && confirmingDisconnect && (
        <div className="strava-confirm">
          <p>Disconnecting revokes Lock In at Strava and deletes your tokens. You cannot check in until you reconnect.</p>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void disconnect()}>
            {busy ? "DISCONNECTING…" : "CONFIRM DISCONNECT"}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingDisconnect(false)}>
            KEEP CONNECTED
          </button>
        </div>
      )}

      {message && <p className="form-status">{message}</p>}
    </div>
  );
}

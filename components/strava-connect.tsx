"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  STRAVA_CALLBACK_MESSAGES,
  disconnectStrava,
  startStravaAuthorization,
  stravaConnection,
} from "@/src/strava-client";
import {
  canStartAuthorization,
  resolveStravaView,
  type ConnectionRead,
} from "@/src/strava-connection-view";
import { ensureWalletSession, hasWalletSession } from "@/src/wallet-auth-client";

/**
 * Connect Strava once, then check in.
 *
 * The athlete authorises Lock In on Strava's own screen a single time. Every later check-in reuses the
 * stored refresh token: no second login, nothing to install, nothing to rename.
 *
 * All the state logic lives in src/strava-connection-view.ts and is tested there. This component only
 * gathers the two facts it needs and renders the answer.
 */

export function StravaConnect({ onConnectedChange }: { onConnectedChange?: (connected: boolean) => void }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [walletSession, setWalletSession] = useState<boolean | "unknown">("unknown");
  const [connection, setConnection] = useState<ConnectionRead>("unknown");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const view = resolveStravaView({ wallet: address, walletSession, connection });

  useEffect(() => {
    onConnectedChange?.(view.kind === "strava_connected");
  }, [view.kind, onConnectedChange]);

  useEffect(() => {
    // What Strava sent the athlete back with. Read once, then removed, so a refresh does not replay it.
    const outcome = new URLSearchParams(window.location.search).get("strava");
    if (!outcome) return;
    setMessage(STRAVA_CALLBACK_MESSAGES[outcome] || STRAVA_CALLBACK_MESSAGES.failed);
    const url = new URL(window.location.href);
    url.searchParams.delete("strava");
    window.history.replaceState(null, "", url.toString());
  }, []);

  const readConnection = useCallback(async (wallet: string) => {
    try {
      const answer = await stravaConnection(wallet);
      // Stamped with the wallet it was read for: a late answer must never land on another wallet.
      setConnection({ wallet, connected: answer.connected, athleteId: answer.athleteId });
    } catch {
      // Unreachable is not "disconnected". Claiming otherwise would offer to re-authorise a live grant.
      setConnection("unreachable");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      setConnection("unknown");
      if (!address) {
        setWalletSession("unknown");
        return;
      }
      // Never prompts: this only reads the existing cookie.
      const session = await hasWalletSession(address);
      if (cancelled) return;
      setWalletSession(session);
      // Without a session the connection is unknowable, and unknowable is NOT disconnected: the refresh
      // token can sit in the database for weeks after our 12h cookie expires.
      if (session) await readConnection(address);
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, [address, readConnection]);

  async function unlockStatus() {
    if (!address) return setMessage("Connect your wallet first.");
    setBusy(true);
    setMessage(null);
    try {
      await ensureWalletSession(address, (text) => signMessageAsync({ message: text }));
      setWalletSession(true);
      await readConnection(address);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read your Strava status.");
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    if (!address) return setMessage("Connect your wallet first.");
    // Belt and braces: only the server saying the database has nothing may send anyone to Strava.
    if (!canStartAuthorization(view)) return;
    setBusy(true);
    setMessage(null);
    try {
      await ensureWalletSession(address, (text) => signMessageAsync({ message: text }));
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
      setConnection({ wallet: address, connected: false });
      setConfirmingDisconnect(false);
      setMessage("Strava disconnected. Your tokens are revoked and deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not disconnect Strava.");
    } finally {
      setBusy(false);
    }
  }

  if (!address) return null;

  const title = view.kind === "strava_connected"
    ? "Strava connected"
    : view.kind === "wallet_session_required"
      ? "Strava status locked"
      : view.kind === "strava_not_connected"
        ? "Connect Strava"
        : "Checking Strava…";

  const detail = view.kind === "strava_connected"
    ? `Athlete ${view.athleteId ?? "linked"}. We read only the run you check in, never your route.`
    : view.kind === "wallet_session_required"
      ? "Your signed session expired. Sign once to read your status. Your Strava authorization is untouched."
      : view.kind === "strava_not_connected"
        ? "One authorization on Strava. After that, checking in is a single tap."
        : "Reading your Strava status…";

  return (
    <div className="strava-connect" aria-live="polite">
      <div className="strava-connect-body">
        <span className={`strava-dot ${view.kind === "strava_connected" ? "on" : "off"}`} aria-hidden="true" />
        <div>
          <b>{title}</b>
          <small>{detail}</small>
        </div>
      </div>

      {view.kind === "wallet_session_required" && (
        <button type="button" className="lock-button" disabled={busy} onClick={() => void unlockStatus()}>
          {busy ? "CHECKING…" : "UNLOCK STRAVA STATUS"}
        </button>
      )}

      {view.kind === "strava_not_connected" && (
        <button type="button" className="lock-button" disabled={busy} onClick={() => void connect()}>
          {busy ? "OPENING STRAVA…" : "CONNECT STRAVA"}
        </button>
      )}

      {view.kind === "strava_connected" && !confirmingDisconnect && (
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>
          DISCONNECT
        </button>
      )}

      {view.kind === "strava_connected" && confirmingDisconnect && (
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

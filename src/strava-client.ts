import type { Hex } from "viem";

/**
 * Browser side of the Strava flow. Two calls, and neither ever sees a token: the server holds the OAuth
 * grant, reads the run from Strava, and hands back a signed attestation the wallet can publish.
 */

export type StravaConnectionState = { connected: boolean; athleteId?: string; scopes?: string };

export type StravaCheckIn = {
  evidence: Record<string, unknown>;
  signature: Hex;
  run: {
    activityId: string;
    name: string;
    distanceMeters: number;
    movingTimeSeconds: number;
    startedAt: string;
  };
};

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((payload as { error?: string }).error || "Strava request failed"));
  return payload as T;
}

export function stravaConnection(walletAddress: string): Promise<StravaConnectionState> {
  return call<StravaConnectionState>("/api/strava/connection", {
    method: "POST",
    body: JSON.stringify({ walletAddress }),
  });
}

/** Sends the athlete to Strava. They come back to `/` with a `?strava=` outcome. */
export async function startStravaAuthorization(walletAddress: string): Promise<void> {
  const { authorizeUrl } = await call<{ authorizeUrl: string }>("/api/strava/authorize", {
    method: "POST",
    body: JSON.stringify({ walletAddress }),
  });
  window.location.assign(authorizeUrl);
}

export function disconnectStrava(walletAddress: string): Promise<{ disconnected: boolean }> {
  return call<{ disconnected: boolean }>("/api/strava/connection", {
    method: "DELETE",
    body: JSON.stringify({ walletAddress }),
  });
}

/** Asks the server to read today's run and attest it. Throws with the exact reason if it does not qualify. */
export function checkInStrava(input: {
  walletAddress: string;
  pactId: string;
  dayIndex: number;
}): Promise<StravaCheckIn> {
  return call<StravaCheckIn>("/api/strava/checkin", { method: "POST", body: JSON.stringify(input) });
}

/** What the athlete reads after coming back from Strava. */
export const STRAVA_CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Strava connected. You can check in after each run.",
  cancelled: "Strava authorization was cancelled.",
  scope_declined: "Lock In needs permission to read your activities, including private ones.",
  athlete_already_linked: "This Strava account is already connected to another wallet.",
  invalid_state: "That authorization link was not valid. Start again from Lock In.",
  failed: "Strava authorization failed. Try again.",
};

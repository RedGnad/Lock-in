/**
 * What the athlete is told about their Strava connection, and when we are allowed to send them to Strava.
 *
 * These are two independent facts and conflating them is the whole bug this file exists to prevent:
 *
 *   - the WALLET SESSION is our cookie. It expires in 12 hours and proves the browser controls the wallet.
 *   - the STRAVA CONNECTION is a row in Neon holding an encrypted refresh token. It does not expire when
 *     the cookie does, and the refresh token is what makes check-in a single tap for weeks.
 *
 * Reading "no cookie" as "no Strava" told an athlete whose grant was intact to authorise Strava again,
 * which is exactly the friction the OAuth pivot existed to remove. Worse, re-authorising is not harmless:
 * it burns a Strava authorisation and rotates tokens for a connection that was fine.
 *
 * So: an expired cookie asks for a signature, never for Strava. Only the SERVER saying `connected: false`
 * may ever start an authorisation.
 */

export type StravaView =
  | { kind: "loading" }
  | { kind: "wallet_session_required" }
  | { kind: "strava_connected"; athleteId?: string }
  | { kind: "strava_not_connected" };

export type ConnectionRead =
  | "unknown"
  | "unreachable"
  /** `wallet` is the address this answer was READ FOR, never the address currently selected. */
  | Readonly<{ wallet: string; connected: boolean; athleteId?: string }>;

export function resolveStravaView(input: {
  wallet?: string;
  walletSession: boolean | "unknown";
  connection: ConnectionRead;
}): StravaView {
  if (!input.wallet) return { kind: "loading" };
  if (input.walletSession === "unknown") return { kind: "loading" };
  // The cookie is gone or expired. The grant may well be intact: ask the wallet, not Strava.
  if (input.walletSession === false) return { kind: "wallet_session_required" };
  if (input.connection === "unknown") return { kind: "loading" };
  // We asked and could not find out. "I don't know" must never be rendered as "you are not connected",
  // because that button sends the athlete to Strava for nothing.
  if (input.connection === "unreachable") return { kind: "loading" };
  // Switching wallets in the browser must never show the previous wallet's Strava state, not even for the
  // instant before the new read lands. The answer is stamped with the wallet it was read for.
  if (input.connection.wallet.toLowerCase() !== input.wallet.toLowerCase()) return { kind: "loading" };
  return input.connection.connected
    ? { kind: "strava_connected", athleteId: input.connection.athleteId }
    : { kind: "strava_not_connected" };
}

/** The only state that may send an athlete to Strava: the server said, from the database, that there is nothing stored. */
export function canStartAuthorization(view: StravaView): boolean {
  return view.kind === "strava_not_connected";
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartAuthorization,
  resolveStravaView,
  type ConnectionRead,
} from "../src/strava-connection-view.js";

const WALLET_A = "0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45";
const WALLET_B = "0x344412229B3b581C19572f9BF1F5d08d4Ae897E6";

test("an expired wallet cookie asks for a signature, never for Strava", () => {
  // The exact production case: Neon still holds an encrypted refresh token, the access token has expired
  // (normal), and only our 12h cookie is gone. Showing CONNECT STRAVA here tells an athlete whose grant is
  // intact to authorise again, which is the friction the OAuth pivot removed.
  const view = resolveStravaView({ wallet: WALLET_A, walletSession: false, connection: "unknown" });
  assert.equal(view.kind, "wallet_session_required");
  assert.equal(canStartAuthorization(view), false, "an expired cookie must never start an authorization");
});

test("one signature restores the connected state, with no trip to Strava", () => {
  // After the signature the server is asked, and the row in Neon answers.
  const view = resolveStravaView({
    wallet: WALLET_A,
    walletSession: true,
    connection: { wallet: WALLET_A, connected: true, athleteId: "1815502280" },
  });
  assert.deepEqual(view, { kind: "strava_connected", athleteId: "1815502280" });
  assert.equal(canStartAuthorization(view), false);
});

test("only the server saying there is no connection may offer CONNECT STRAVA", () => {
  const view = resolveStravaView({
    wallet: WALLET_A,
    walletSession: true,
    connection: { wallet: WALLET_A, connected: false },
  });
  assert.equal(view.kind, "strava_not_connected");
  assert.equal(canStartAuthorization(view), true, "this is the only state allowed to authorise");
});

test("switching wallets never shows the other wallet's Strava state", () => {
  // The stale answer belongs to A. B must see nothing of it, not even for one render.
  const stale: ConnectionRead = { wallet: WALLET_A, connected: true, athleteId: "1815502280" };
  const view = resolveStravaView({ wallet: WALLET_B, walletSession: true, connection: stale });
  assert.equal(view.kind, "loading");
  assert.equal(canStartAuthorization(view), false);
});

test("not knowing is never rendered as not connected", () => {
  // A failed read must not push the athlete to Strava: that button costs a real authorization.
  for (const connection of ["unknown", "unreachable"] as const) {
    const view = resolveStravaView({ wallet: WALLET_A, walletSession: true, connection });
    assert.equal(view.kind, "loading", `${connection} must not claim disconnected`);
    assert.equal(canStartAuthorization(view), false);
  }
});

test("no wallet at all is loading, not an invitation to connect Strava", () => {
  const view = resolveStravaView({ wallet: undefined, walletSession: "unknown", connection: "unknown" });
  assert.equal(view.kind, "loading");
  assert.equal(canStartAuthorization(view), false);
});

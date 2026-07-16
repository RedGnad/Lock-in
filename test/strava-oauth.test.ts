import assert from "node:assert/strict";
import test from "node:test";
import {
  issueStravaState,
  stravaAuthorizeUrl,
  StravaOAuthError,
  STRAVA_SCOPE,
  verifyStravaState,
} from "../src/strava-oauth.js";

const WALLET = "0x344412229B3b581C19572f9BF1F5d08d4Ae897E6";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const ENV = {
  STRAVA_CLIENT_ID: "12345",
  STRAVA_CLIENT_SECRET: "secret-not-used-here",
  SESSION_SIGNING_SECRET: "a-test-session-secret-of-at-least-32-chars",
} as unknown as NodeJS.ProcessEnv;

test("state round-trips the wallet that started the flow", () => {
  const state = issueStravaState(WALLET, ENV);
  assert.equal(verifyStravaState(state, ENV), WALLET);
});

test("state is bound to its wallet and cannot be grafted onto another", () => {
  // The attack this exists for: an attacker completes the Strava consent, then swaps the wallet so their
  // athlete account lands on a victim's connection. The signature covers the wallet, so it cannot be moved.
  const state = issueStravaState(WALLET, ENV);
  const [encoded, signature] = state.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  payload.wallet = OTHER;
  const forged = `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature}`;
  assert.throws(() => verifyStravaState(forged, ENV), /signature mismatch/);
});

test("state signed with another secret is rejected", () => {
  const state = issueStravaState(WALLET, { ...ENV, SESSION_SIGNING_SECRET: "another-secret-of-at-least-32-characters" });
  assert.throws(() => verifyStravaState(state, ENV), /signature mismatch/);
});

test("state expires, so a stale authorize link cannot be replayed later", () => {
  const now = Date.now();
  const state = issueStravaState(WALLET, ENV, now);
  assert.equal(verifyStravaState(state, ENV, now + 9 * 60_000), WALLET);
  assert.throws(() => verifyStravaState(state, ENV, now + 11 * 60_000), /expired/);
});

test("malformed state is rejected on shape", () => {
  for (const broken of ["", "nodot", "a.b.c", "!!!.???"]) {
    assert.throws(() => verifyStravaState(broken, ENV), StravaOAuthError);
  }
});

test("two states for the same wallet differ, so a state is single-use in practice", () => {
  assert.notEqual(issueStravaState(WALLET, ENV), issueStravaState(WALLET, ENV));
});

test("the authorize URL asks for private activities and forces the consent screen", () => {
  const url = new URL(stravaAuthorizeUrl({
    state: issueStravaState(WALLET, ENV),
    redirectUri: "https://example.test/api/strava/callback",
    env: ENV,
  }));
  assert.equal(url.origin + url.pathname, "https://www.strava.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "12345");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.test/api/strava/callback");
  // read_all: an athlete with private activities must not stake first and discover the gap after.
  assert.equal(url.searchParams.get("scope"), STRAVA_SCOPE);
  assert.equal(STRAVA_SCOPE, "activity:read_all");
  // force: otherwise Strava silently reuses a narrower prior grant.
  assert.equal(url.searchParams.get("approval_prompt"), "force");
  assert.equal(verifyStravaState(url.searchParams.get("state")!, ENV), WALLET);
});

test("a missing signing secret fails closed rather than issuing an unsigned state", () => {
  assert.throws(() => issueStravaState(WALLET, { ...ENV, SESSION_SIGNING_SECRET: "" }), /at least 32 characters/);
  assert.throws(() => issueStravaState(WALLET, { ...ENV, SESSION_SIGNING_SECRET: "too-short" }), /at least 32 characters/);
});

test("a missing client id fails closed rather than building a broken authorize URL", () => {
  assert.throws(
    () => stravaAuthorizeUrl({ state: "x", redirectUri: "https://example.test/cb", env: { ...ENV, STRAVA_CLIENT_ID: "" } }),
    /STRAVA_CLIENT_ID is not configured/,
  );
});

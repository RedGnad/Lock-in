import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
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

test("state round-trips the wallet that started the flow, and yields what burns it", () => {
  const state = issueStravaState(WALLET, ENV);
  const verified = verifyStravaState(state, ENV);
  assert.equal(verified.wallet, WALLET);
  // The callback needs these to record the state as spent; the signature alone cannot stop a replay.
  assert.match(verified.nonceHash, /^[0-9a-f]{64}$/);
  assert.ok(verified.expiresAt.getTime() > Date.now());
});

test("each state carries its own nonce hash, so burning one cannot burn another", () => {
  const first = verifyStravaState(issueStravaState(WALLET, ENV), ENV);
  const second = verifyStravaState(issueStravaState(WALLET, ENV), ENV);
  assert.notEqual(first.nonceHash, second.nonceHash);
});

test("the same state always yields the same nonce hash, so a replay is recognisable", () => {
  // This is what makes single-use enforceable: a replayed state hashes to a nonce already recorded.
  const state = issueStravaState(WALLET, ENV);
  assert.equal(verifyStravaState(state, ENV).nonceHash, verifyStravaState(state, ENV).nonceHash);
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
  assert.equal(verifyStravaState(state, ENV, now + 9 * 60_000).wallet, WALLET);
  assert.throws(() => verifyStravaState(state, ENV, now + 11 * 60_000), /expired/);
});

test("malformed state is rejected on shape", () => {
  for (const broken of ["", "nodot", "a.b.c", "!!!.???"]) {
    assert.throws(() => verifyStravaState(broken, ENV), StravaOAuthError);
  }
});

test("two states for the same wallet are never the same string", () => {
  assert.notEqual(issueStravaState(WALLET, ENV), issueStravaState(WALLET, ENV));
});

test("a state with no nonce is refused, since it could never be burned", () => {
  const forged = Buffer.from(JSON.stringify({ wallet: WALLET, exp: Date.now() + 60_000 }), "utf8").toString("base64url");
  const signature = createHmac("sha256", String(ENV.SESSION_SIGNING_SECRET)).update(forged).digest("base64url");
  assert.throws(() => verifyStravaState(`${forged}.${signature}`, ENV), /carries no nonce/);
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
  assert.equal(verifyStravaState(url.searchParams.get("state")!, ENV).wallet, WALLET);
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  createReclaimResumeSession,
  reclaimResumeStorageKey,
  validateReclaimResumeSession,
} from "../src/reclaim-resume.js";

const NOW = 1_800_000_000_000;
const WALLET = "0x1111111111111111111111111111111111111111";
const CHALLENGE = "LI-RESUME";

function token(overrides: Record<string, unknown> = {}) {
  const payload = {
    sessionId: "session_12345678",
    walletAddress: WALLET,
    pactId: "7",
    dayIndex: 2,
    challenge: CHALLENGE,
    exp: NOW + 20 * 60_000,
    ...overrides,
  };
  return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.client-does-not-trust-this-signature`;
}

const context = {
  pactId: "7",
  walletAddress: WALLET,
  challenge: CHALLENGE,
  durationDays: 7,
};

test("creates and validates a resume session bound to the proof context", () => {
  const session = createReclaimResumeSession({
    token: token(),
    sessionId: "session_12345678",
    dayIndex: 2,
    ...context,
  }, NOW);
  assert.ok(session);
  assert.equal(session.pactId, "7");
  assert.equal(session.walletAddress, WALLET);
  assert.equal(validateReclaimResumeSession(session, context, NOW + 1_000).ok, true);
  assert.equal(reclaimResumeStorageKey("0007"), "lock-in-reclaim-session:7");
});

test("rejects resume data for another wallet, pact, challenge, or day", () => {
  const session = createReclaimResumeSession({
    token: token(),
    sessionId: "session_12345678",
    dayIndex: 2,
    ...context,
  }, NOW);
  assert.ok(session);
  assert.equal(validateReclaimResumeSession(session, { ...context, walletAddress: "0x2222222222222222222222222222222222222222" }, NOW).ok, false);
  assert.equal(validateReclaimResumeSession(session, { ...context, pactId: "8" }, NOW).ok, false);
  assert.equal(validateReclaimResumeSession(session, { ...context, challenge: "LI-OTHER" }, NOW).ok, false);
  assert.equal(validateReclaimResumeSession({ ...session, dayIndex: 8 }, context, NOW).ok, false);
});

test("rejects expired, malformed, and token-mismatched resume data", () => {
  const session = createReclaimResumeSession({
    token: token(),
    sessionId: "session_12345678",
    dayIndex: 2,
    ...context,
  }, NOW);
  assert.ok(session);
  assert.deepEqual(validateReclaimResumeSession(session, context, NOW + 20 * 60_000), { ok: false, reason: "expired" });
  assert.equal(validateReclaimResumeSession({ ...session, token: "broken" }, context, NOW).ok, false);
  assert.equal(validateReclaimResumeSession({ ...session, sessionId: "another-session" }, context, NOW).ok, false);
  assert.equal(validateReclaimResumeSession(null, context, NOW).ok, false);
});

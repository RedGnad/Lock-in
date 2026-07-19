import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "viem";
import {
  ATTESTATION_SAFETY_MARGIN_SECONDS,
  attestationIsFresh,
  createPactArgs,
  joinPactArgs,
  parseBaselineEvidence,
  parseFinalEvidence,
  resolveDuolingoLockLifecycle,
  resolveDuolingoMode,
  submitFinalArgs,
} from "../src/duolingo-escrow-client.js";

const NONCE = `0x${"a1".repeat(32)}` as Hex;
const H = (b: string) => `0x${b.repeat(32)}`;
const SIG = `0x${"cd".repeat(65)}`;

const baselineJson = {
  configHash: H("11"), identityHash: H("22"), nullifier: H("33"),
  issuedAt: "1800000000", expiresAt: "1800000300", signature: SIG,
};
const finalJson = {
  identityHash: H("22"), earnedXp: 60, targetXp: 50, nullifier: H("44"),
  occurredAt: "1800000100", issuedAt: "1800000100", expiresAt: "1800000400", signature: SIG,
};

test("the display mode reflects address, pauses and signer verification", () => {
  assert.deepEqual(resolveDuolingoMode({ hasAddress: false, anyPaused: null }),
    { status: "live-proof", badge: "BETA · LIVE PROOF", canTransact: false });
  // Address present but pauses not yet read: never treated as open.
  assert.equal(resolveDuolingoMode({ hasAddress: true, anyPaused: null }).status, "canary-paused");
  assert.equal(resolveDuolingoMode({ hasAddress: true, anyPaused: true }).status, "canary-paused");
  // Open only when nothing is paused AND the signer is not explicitly unverified.
  assert.equal(resolveDuolingoMode({ hasAddress: true, anyPaused: false }).status, "live-usdc");
  assert.equal(resolveDuolingoMode({ hasAddress: true, anyPaused: false, signerVerified: false }).status, "canary-paused");
  assert.equal(resolveDuolingoMode({ hasAddress: true, anyPaused: false, signerVerified: true }).canTransact, true);
});

test("Duolingo lifecycle exposes contract-permitted cancellation refunds immediately", () => {
  const terms = {
    startsAt: 1_000,
    durationSeconds: 300,
    graceSeconds: 60,
    participantCount: 1,
    minParticipants: 2,
    cancelled: false,
    finalized: false,
  };

  const registration = resolveDuolingoLockLifecycle({ ...terms, now: 999 });
  assert.equal(registration.beforeStart, true);
  assert.equal(registration.underfilled, false);
  assert.equal(registration.canFinalize, false);

  const underfilled = resolveDuolingoLockLifecycle({ ...terms, now: 1_000 });
  assert.equal(underfilled.duringChallenge, false);
  assert.equal(underfilled.underfilled, true);
  assert.equal(underfilled.canFinalize, true);

  const active = resolveDuolingoLockLifecycle({ ...terms, now: 1_000, participantCount: 2 });
  assert.equal(active.duringChallenge, true);
  assert.equal(active.underfilled, false);
  assert.equal(active.canFinalize, false);

  const cancelled = resolveDuolingoLockLifecycle({ ...terms, now: 999, cancelled: true });
  assert.equal(cancelled.canFinalize, true);

  const grace = resolveDuolingoLockLifecycle({ ...terms, now: 1_350, participantCount: 2 });
  assert.equal(grace.pastDeadline, false);
  assert.equal(grace.canFinalize, false);

  const deadline = resolveDuolingoLockLifecycle({ ...terms, now: 1_360, participantCount: 2 });
  assert.equal(deadline.pastDeadline, true);
  assert.equal(deadline.canFinalize, true);
});

test("baseline and final attestations parse strings into on-chain bigints", () => {
  const b = parseBaselineEvidence(baselineJson);
  assert.equal(b.issuedAt, 1_800_000_000n);
  assert.equal(b.expiresAt, 1_800_000_300n);
  assert.equal(b.configHash, H("11"));
  const f = parseFinalEvidence(finalJson);
  assert.equal(f.earnedXp, 60);
  assert.equal(f.occurredAt, 1_800_000_100n);
});

test("a malformed attestation is rejected rather than sent to the contract", () => {
  assert.throws(() => parseBaselineEvidence({ ...baselineJson, signature: "0x1234" }), /signature/);
  assert.throws(() => parseBaselineEvidence({ ...baselineJson, configHash: "nope" }), /config hash/);
  assert.throws(() => parseBaselineEvidence({ ...baselineJson, expiresAt: "-1" }), /expiry/);
  assert.throws(() => parseFinalEvidence({ ...finalJson, earnedXp: -1 }), /earned XP/);
  assert.throws(() => parseFinalEvidence({ ...finalJson, earnedXp: 1.5 }), /earned XP/);
});

test("freshness leaves a margin so a two-transaction flow does not revert on expiry", () => {
  const now = 1_800_000_000;
  assert.equal(attestationIsFresh(BigInt(now + ATTESTATION_SAFETY_MARGIN_SECONDS + 1), now), true);
  assert.equal(attestationIsFresh(BigInt(now + ATTESTATION_SAFETY_MARGIN_SECONDS), now), false);
  assert.equal(attestationIsFresh(BigInt(now - 1), now), false);
});

test("createPact args carry the terms, the exact createNonce, and the baseline struct", () => {
  const baseline = parseBaselineEvidence(baselineJson);
  const terms = {
    stake: 100_000n, targetXp: 50, durationSeconds: 3_600, minParticipants: 2, maxParticipants: 2,
    startsAt: 1_800_000_000n, createNonce: NONCE,
  };
  const args = createPactArgs(terms, baseline);
  assert.deepEqual(args, [100_000n, 50, 3_600, 2, 2, 1_800_000_000n, NONCE, baseline]);
  // The nonce must pass through byte for byte: the configHash and the stored baseline depend on it.
  assert.equal(args[6], NONCE);
  assert.equal(args[7], baseline);
  assert.throws(() => createPactArgs({ ...terms, createNonce: "0xabc" as Hex }, baseline), /create nonce/);
});

test("join and final args are positional and carry the struct object viem expects", () => {
  const baseline = parseBaselineEvidence(baselineJson);
  const final = parseFinalEvidence(finalJson);
  assert.deepEqual(joinPactArgs(7n, baseline), [7n, baseline]);
  assert.deepEqual(submitFinalArgs(7n, final), [7n, final]);
});

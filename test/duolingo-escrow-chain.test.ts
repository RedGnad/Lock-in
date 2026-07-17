import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEscrowFinalOpen,
  SUBMISSION_GRACE_SECONDS,
  type EscrowPactView,
} from "../src/duolingo-escrow-chain.js";

const NOW = 1_800_000_000;
const DURATION = 3_600;

// A Lock that is live and finalizable at NOW: started 100s ago, ends well after NOW.
function pact(overrides: Partial<EscrowPactView> = {}): EscrowPactView {
  return {
    configHash: `0x${"cc".repeat(32)}`,
    targetXp: 50,
    startsAt: NOW - 100,
    durationSeconds: DURATION,
    participantCount: 2,
    minParticipants: 2,
    maxParticipants: 2,
    finalized: false,
    cancelled: false,
    joined: true,
    completed: false,
    participantIdentity: `0x${"11".repeat(32)}`,
    ...overrides,
  };
}

test("a live, joined, filled Lock accepts a fresh final capture", () => {
  assert.doesNotThrow(() => assertEscrowFinalOpen(pact(), "capture", NOW));
});

test("state the contract would reject is refused before signing", () => {
  const cases: [Partial<EscrowPactView>, RegExp][] = [
    [{ joined: false }, /participant/],
    [{ completed: true }, /already completed/],
    [{ cancelled: true }, /closed/],
    [{ finalized: true }, /closed/],
    [{ participantCount: 1 }, /did not fill/],
    [{ startsAt: NOW + 60 }, /not started/],
  ];
  for (const [overrides, message] of cases) {
    assert.throws(() => assertEscrowFinalOpen(pact(overrides), "submit", NOW), message);
  }
});

test("capturing a proof is refused once the challenge has ended, but submitting is allowed through grace", () => {
  const ended = pact({ startsAt: NOW - DURATION - 10 }); // ended 10s ago
  assert.throws(() => assertEscrowFinalOpen(ended, "capture", NOW), /challenge window has ended/);
  // Within the grace period a proof captured earlier can still be submitted.
  assert.doesNotThrow(() => assertEscrowFinalOpen(ended, "submit", NOW));
});

test("submitting is refused once the grace period has elapsed", () => {
  const past = pact({ startsAt: NOW - DURATION - SUBMISSION_GRACE_SECONDS - 10 });
  assert.throws(() => assertEscrowFinalOpen(past, "submit", NOW), /submission window has closed/);
});

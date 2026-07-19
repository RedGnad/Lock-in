import assert from "node:assert/strict";
import test from "node:test";
import { EscrowConfigError, parseEscrowCreateTerms } from "../src/duolingo-escrow-config.js";

const NOW = 1_800_000_000;
const valid = {
  stake: "100000",
  targetXp: 50,
  durationSeconds: 3_600,
  minParticipants: 2,
  maxParticipants: 2,
  startsAt: NOW + 30 * 60,
};

test("a valid same-day canary configuration parses", () => {
  const terms = parseEscrowCreateTerms(valid, NOW);
  assert.equal(terms.stake, 100_000n);
  assert.equal(terms.targetXp, 50);
  assert.equal(terms.startsAt, BigInt(NOW + 30 * 60));
});

test("stakes outside 0.1 to 1 USDC are refused", () => {
  for (const stake of ["99999", "1000001", "0", "-1"]) {
    assert.throws(() => parseEscrowCreateTerms({ ...valid, stake }, NOW), EscrowConfigError);
  }
});

test("targets, durations and participant ranges are bounded", () => {
  assert.throws(() => parseEscrowCreateTerms({ ...valid, targetXp: 9 }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, targetXp: 1_000_001 }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, durationSeconds: 60 }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, durationSeconds: 40 * 24 * 60 * 60 }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, minParticipants: 1 }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, minParticipants: 3, maxParticipants: 2 }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, maxParticipants: 101 }, NOW), EscrowConfigError);
});

test("the start must be in the future and within 24 hours", () => {
  assert.throws(() => parseEscrowCreateTerms({ ...valid, startsAt: NOW }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, startsAt: NOW - 1 }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, startsAt: NOW + 25 * 60 * 60 }, NOW), EscrowConfigError);
  assert.ok(parseEscrowCreateTerms({ ...valid, startsAt: NOW + 23 * 60 * 60 }, NOW));
});

test("non-numeric fields are rejected rather than coerced to a wrong value", () => {
  assert.throws(() => parseEscrowCreateTerms({ ...valid, targetXp: "abc" }, NOW), EscrowConfigError);
  assert.throws(() => parseEscrowCreateTerms({ ...valid, stake: "not-a-number" }, NOW), EscrowConfigError);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertFreshProofTimestamps,
  validateStravaEvidence,
  type ReclaimTrustedData,
  type StravaPactPolicy,
} from "../src/strava-proof-policy.js";
import { consumeSessionOnce } from "../src/proof-session-store.js";
import { dailyProofCode } from "../src/pact-code.js";
import { issueProofSessionToken, verifyProofSessionToken } from "../src/session-token.js";

const sessionId = "session_123456789";
const walletAddress = "0x000000000000000000000000000000000000dEaD";
const pactChallenge = "LI-7M4Q9X2K8P6R3T5V";
const challenge = dailyProofCode(pactChallenge, 0);
const startTime = "2026-07-14T13:04:46+0000";

const policy: StravaPactPolicy = {
  walletAddress,
  pactId: "42",
  dayIndex: 0,
  challenge,
  expectedSessionId: sessionId,
  startsAtMs: Date.parse("2026-07-14T13:00:00Z"),
  endsAtMs: Date.parse("2026-07-14T14:00:00Z"),
  minDistanceMeters: 1_000,
};

function context(): Record<string, string> {
  return {
    contextAddress: walletAddress.toLowerCase(),
    contextMessage: "42:0",
    reclaimSessionId: sessionId,
  };
}

function validData(overrides: Record<string, string> = {}): ReclaimTrustedData[] {
  const values = {
    marker: "userId: 1815502280",
    id: "19309163477",
    name: challenge,
    type: "Run",
    time: startTime,
    raw: "1000",
    flagged: "false",
    moving: "600",
    elapsed: "600",
    elevation: "0",
    latlng: "true",
    trainer: "false",
    ...overrides,
  };
  return [
    { context: context(), extractedParameters: { marker: values.marker } },
    { context: context(), extractedParameters: {
      id: values.id,
      name: values.name,
      type: values.type,
      time: values.time,
      raw: values.raw,
      flagged: values.flagged,
      moving: values.moving,
      elapsed: values.elapsed,
      elevation: values.elevation,
    } },
    { context: context(), extractedParameters: { latlng: values.latlng } },
    { context: context(), extractedParameters: { trainer: values.trainer } },
  ];
}

test("accepts a challenge-bound Strava GPS-run record", () => {
  const evidence = validateStravaEvidence(validData(), policy);
  assert.equal(evidence.distanceMeters, 1_000);
  assert.equal(evidence.hasGps, true);
  assert.match(evidence.nullifier, /^0x[0-9a-f]{64}$/);
});

test("derives deterministic, non-overlapping daily proof codes", () => {
  assert.equal(dailyProofCode(pactChallenge, 0), `${pactChallenge}D01`);
  assert.equal(dailyProofCode(pactChallenge, 9), `${pactChallenge}D10`);
  assert.equal(dailyProofCode(pactChallenge, 29), `${pactChallenge}D30`);
  assert.notEqual(dailyProofCode(pactChallenge, 0), dailyProofCode(pactChallenge, 9));
});

test("binds the deterministic daily code inside the signed session token", () => {
  process.env.SESSION_SIGNING_SECRET = "test-session-secret-that-is-at-least-32-characters";
  const proofCode = dailyProofCode(pactChallenge, 9);
  const token = issueProofSessionToken({
    sessionId,
    walletAddress,
    pactId: "42",
    dayIndex: 9,
    challenge: pactChallenge,
    proofCode,
    startsAtMs: policy.startsAtMs,
    endsAtMs: policy.endsAtMs,
    minDistanceMeters: policy.minDistanceMeters,
    claimDeadlineMs: policy.endsAtMs + 3_600_000,
  });
  assert.equal(verifyProofSessionToken(token).proofCode, proofCode);
});

for (const [name, overrides, code] of [
  ["manual/no-GPS activity", { latlng: "false" }, "NO_GPS"],
  ["trainer activity", { trainer: "true" }, "TRAINER_ACTIVITY"],
  ["Strava-flagged activity", { flagged: "true" }, "FLAGGED_ACTIVITY"],
  ["zero moving time", { moving: "0" }, "INVALID_MOTION"],
  ["elapsed shorter than moving", { moving: "600", elapsed: "599" }, "INVALID_MOTION"],
  ["implausibly fast run", { raw: "1000", moving: "100", elapsed: "100" }, "IMPLAUSIBLE_SPEED"],
  ["implausibly slow run", { raw: "1000", moving: "2001", elapsed: "2001" }, "IMPLAUSIBLE_PACE"],
  ["implausible pause ratio", { raw: "1000", moving: "600", elapsed: "3301" }, "IMPLAUSIBLE_ELAPSED_TIME"],
  ["wrong sport", { type: "Ride" }, "WRONG_SPORT"],
  ["missing challenge", { name: "Morning Run" }, "WRONG_CHALLENGE"],
  ["free-form title containing the challenge", { name: `Morning Run ${challenge}` }, "WRONG_CHALLENGE"],
  ["short distance", { raw: "999" }, "DISTANCE_TOO_SHORT"],
  ["activity outside the pact window", { time: "2026-07-14T12:59:59+0000" }, "OUTSIDE_PACT_WINDOW"],
  ["activity exactly at the exclusive end", { time: "2026-07-14T14:00:00+0000" }, "OUTSIDE_PACT_WINDOW"],
] as const) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => validateStravaEvidence(validData(overrides), policy),
      (error: unknown) => error instanceof Error && "code" in error && error.code === code,
    );
  });
}

test("rejects a proof bound to another session", () => {
  const data = validData();
  data[0].context.reclaimSessionId = "session_attacker";
  assert.throws(() => validateStravaEvidence(data, policy), /initiated Reclaim session/);
});

test("rejects stale proof timestamps", () => {
  const nowMs = Date.parse("2026-07-14T14:00:00Z");
  assertFreshProofTimestamps([Math.floor(nowMs / 1_000) - 599], nowMs);
  assert.throws(
    () => assertFreshProofTimestamps([Math.floor(nowMs / 1_000) - 601], nowMs),
    /too old/,
  );
});

test("atomically rejects a consumed session replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "lock-in-session-"));
  try {
    const nullifier = `0x${"ab".repeat(32)}`;
    await consumeSessionOnce(root, sessionId, nullifier);
    await assert.rejects(
      consumeSessionOnce(root, sessionId, nullifier),
      /REPLAYED_SESSION/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects reuse of one Strava activity across two sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lock-in-activity-"));
  try {
    const nullifier = `0x${"cd".repeat(32)}`;
    await consumeSessionOnce(root, "session_first_123", nullifier);
    await assert.rejects(
      consumeSessionOnce(root, "session_second_456", nullifier),
      /REUSED_ACTIVITY/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

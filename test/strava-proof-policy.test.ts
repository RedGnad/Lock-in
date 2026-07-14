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

const sessionId = "session_123456789";
const walletAddress = "0x000000000000000000000000000000000000dEaD";
const challenge = "LI-7M4Q9X2K8P6R3T5V";
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
    name: `Morning Run ${challenge}`,
    type: "Run",
    time: startTime,
    raw: "1000",
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
    } },
    { context: context(), extractedParameters: { latlng: values.latlng } },
    { context: context(), extractedParameters: { trainer: values.trainer } },
  ];
}

test("accepts a challenge-bound outdoor GPS run", () => {
  const evidence = validateStravaEvidence(validData(), policy);
  assert.equal(evidence.distanceMeters, 1_000);
  assert.equal(evidence.hasGps, true);
  assert.match(evidence.nullifier, /^0x[0-9a-f]{64}$/);
});

for (const [name, overrides, code] of [
  ["manual/no-GPS activity", { latlng: "false" }, "NO_GPS"],
  ["trainer activity", { trainer: "true" }, "TRAINER_ACTIVITY"],
  ["wrong sport", { type: "Ride" }, "WRONG_SPORT"],
  ["missing challenge", { name: "Morning Run" }, "WRONG_CHALLENGE"],
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

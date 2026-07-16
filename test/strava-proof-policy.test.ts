import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeSessionOnce } from "../src/proof-session-store.js";
import {
  assertFreshProofTimestamps,
  canonicalizeStravaProofs,
  validateStravaEvidence,
  type ReclaimTrustedData,
  type StravaPactPolicy,
} from "../src/strava-proof-policy.js";

const sessionId = "session_123456789";
const walletAddress = "0x000000000000000000000000000000000000dEaD";
const startTime = "2026-07-14T13:04:46+0000";

const policy: StravaPactPolicy = {
  walletAddress,
  pactId: "42",
  dayIndex: 0,
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
    name: "Morning run",
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
  // The 7.0.0 provider returns two claims: the athlete marker, then one combined activity claim.
  // No context_challenge: the run is tied to the Lock by the day window, not by its title.
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
      latlng: values.latlng,
      trainer: values.trainer,
    } },
  ];
}

test("accepts a Strava GPS-run record inside the Lock day window", () => {
  const evidence = validateStravaEvidence(validData(), policy);
  assert.equal(evidence.distanceMeters, 1_000);
  assert.equal(evidence.hasGps, true);
  assert.match(evidence.nullifier, /^0x[0-9a-f]{64}$/);
});

test("canonicalizes the two Strava proofs by the shape of their signed extracted parameters", () => {
  // The provider signs no providerHash, so the role is read from extractedParameters.
  const fake = (extractedParameters: Record<string, string>) => ({
    claimData: { context: JSON.stringify({ extractedParameters }) },
  });
  const marker = fake({ marker: "userId: 1815502280" });
  const activity = fake({ id: "19309163477", name: "Morning run" });

  assert.deepEqual(canonicalizeStravaProofs([activity, marker] as never), [marker, activity]);
  assert.deepEqual(canonicalizeStravaProofs([marker, activity] as never), [marker, activity]);
  assert.throws(() => canonicalizeStravaProofs([marker, marker] as never), /repeats a request schema/);
  assert.throws(() => canonicalizeStravaProofs([marker] as never), /exactly two proofs/);
  assert.throws(
    () => canonicalizeStravaProofs([marker, fake({ name: "Morning run" })] as never),
    /does not match a pinned request schema/,
  );
  // A claim that looks like both roles at once is ambiguous and must not be ordered.
  assert.throws(
    () => canonicalizeStravaProofs([marker, fake({ marker: "userId: 1", id: "1" })] as never),
    /does not match a pinned request schema/,
  );
});

test("accepts any activity title: the athlete never retitles a run", () => {
  // 7.0.0 dropped the title binding. What ties the run to this Lock is the day window here, and the
  // escrow's global activity nullifier on-chain.
  for (const name of ["Morning run", "", "Course du soir 🏃", "LI-SOMETHING-ELSED02"]) {
    const evidence = validateStravaEvidence(validData({ name }), policy);
    assert.equal(evidence.activityName, name);
  }
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
  ["short distance", { raw: "999" }, "DISTANCE_TOO_SHORT"],
  ["activity outside the pact window", { time: "2026-07-14T12:59:59+0000" }, "OUTSIDE_PACT_WINDOW"],
  ["activity exactly at the exclusive end", { time: "2026-07-14T14:00:00+0000" }, "OUTSIDE_PACT_WINDOW"],
  ["non-canonical athlete marker spacing", { marker: "userId:   1815502280" }, "INVALID_ATHLETE"],
  ["zero-padded activity id", { id: "019309163477" }, "INVALID_ACTIVITY"],
  ["activity id above uint64", { id: "18446744073709551616" }, "INVALID_ACTIVITY"],
  ["zero-padded distance", { raw: "01000" }, "INVALID_DISTANCE"],
  ["zero-padded motion metric", { moving: "0600" }, "INVALID_MOTION"],
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

test("rejects two claims that disagree on a field they both sign", () => {
  const data = validData();
  // Give the marker claim its own conflicting copy of a field the activity claim also signs.
  data[0].extractedParameters.id = "99999999999";
  assert.throws(
    () => validateStravaEvidence(data, policy),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICTING_FIELD",
  );
});

test("rejects stale proof timestamps", () => {
  const nowMs = Date.parse("2026-07-14T14:00:00Z");
  assertFreshProofTimestamps([Math.floor(nowMs / 1_000) - 599], nowMs);
  assert.throws(
    () => assertFreshProofTimestamps([Math.floor(nowMs / 1_000) - 601], nowMs),
    /too old/,
  );
  assert.throws(
    () => assertFreshProofTimestamps([Math.floor(nowMs / 1_000) - 121, Math.floor(nowMs / 1_000)], nowMs),
    /one verification window/,
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

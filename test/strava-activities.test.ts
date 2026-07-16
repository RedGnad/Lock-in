// The pseudonymisation key must exist before the module under test reads it.
process.env.STRAVA_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, stringToHex } from "viem";
import {
  selectQualifyingRun,
  StravaActivityError,
  type StravaActivity,
} from "../src/strava-activities.js";

const DAY_START = Date.parse("2026-07-16T00:00:00Z");
const POLICY = {
  athleteId: "1815502280",
  startsAtMs: DAY_START,
  endsAtMs: DAY_START + 86_400_000,
  minDistanceMeters: 500,
};

function run(overrides: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: 19335732297,
    name: "Course à pied dans l'après-midi",
    sport_type: "Run",
    distance: 733.9,
    moving_time: 433,
    elapsed_time: 584,
    total_elevation_gain: 4,
    start_date: "2026-07-16T11:56:17Z",
    manual: false,
    trainer: false,
    flagged: false,
    start_latlng: [48.85, 2.35],
    ...overrides,
  };
}

test("accepts a real GPS run inside the Lock day", () => {
  const evidence = selectQualifyingRun([run()], POLICY);
  assert.equal(evidence.distanceMeters, 733); // floored, never rounded up in the athlete's favour
  assert.equal(evidence.movingTimeSeconds, 433);
  assert.equal(evidence.activityId, "19335732297");
  assert.match(evidence.nullifier, /^0x[0-9a-f]{64}$/);
  assert.match(evidence.identityHash, /^0x[0-9a-f]{64}$/);
});

test("published identifiers are not bare hashes of an enumerable Strava id", () => {
  // Strava ids are small integers. keccak256(id) would be trivially reversible by enumeration, so the
  // published values must depend on a server-held key.
  const evidence = selectQualifyingRun([run()], POLICY);
  assert.notEqual(evidence.nullifier, keccak256(stringToHex("STRAVA_OAUTH_V1:activity:19335732297")));
  assert.notEqual(evidence.identityHash, keccak256(stringToHex("STRAVA_OAUTH_V1:athlete:1815502280")));
});

test("EVERY published value is keyed, including the session hash", () => {
  // Regression: sessionIdHash was built in the check-in route as keccak256("STRAVA_OAUTH_V1:<id>").
  // Anyone holding a public strava.com/activities/<id> URL could hash it and match the wallet that
  // checked in, which defeats the pseudonymisation of the other three values. Every identifier that
  // reaches calldata must go through the server-held key, so a candidate id proves nothing without it.
  const evidence = selectQualifyingRun([run()], POLICY);
  const published = [evidence.identityHash, evidence.nullifier, evidence.activityHash, evidence.sessionHash];
  const guessable = [
    keccak256(stringToHex("STRAVA_OAUTH_V1:19335732297")),
    keccak256(stringToHex("19335732297")),
    keccak256(stringToHex("STRAVA_OAUTH_V1:1815502280")),
  ];
  for (const value of published) {
    assert.ok(!guessable.includes(value), `${value} is recoverable from an id alone`);
  }
  assert.equal(new Set(published).size, published.length, "distinct roles must not collapse to one value");
});

test("the nullifier is the activity and the identity is the athlete", () => {
  // One run can never be claimed twice, and one Strava account is one participant.
  const first = selectQualifyingRun([run()], POLICY);
  const second = selectQualifyingRun([run({ id: 999, distance: 900 })], POLICY);
  assert.notEqual(first.nullifier, second.nullifier, "two runs must not share a nullifier");
  assert.equal(first.identityHash, second.identityHash, "the same athlete must keep one identity");

  const other = selectQualifyingRun([run()], { ...POLICY, athleteId: "42" });
  assert.notEqual(first.identityHash, other.identityHash, "two athletes must not share an identity");
});

test("picks the longest qualifying run, so a later warm-up cannot cost the day", () => {
  const evidence = selectQualifyingRun([
    run({ id: 1, distance: 600, start_date: "2026-07-16T08:00:00Z" }),
    run({ id: 2, distance: 5_000, moving_time: 1_500, elapsed_time: 1_600, start_date: "2026-07-16T09:00:00Z" }),
    run({ id: 3, distance: 120, moving_time: 60, elapsed_time: 60, start_date: "2026-07-16T20:00:00Z" }),
  ], POLICY);
  assert.equal(evidence.activityId, "2");
});

test("a run outside the Lock day never counts", () => {
  for (const start of ["2026-07-15T23:59:59Z", "2026-07-17T00:00:01Z"]) {
    assert.throws(
      () => selectQualifyingRun([run({ start_date: start })], POLICY),
      (e: unknown) => e instanceof StravaActivityError && e.code === "NO_ACTIVITY_TODAY",
    );
  }
  // The window is inclusive at the start and exclusive at the end, exactly like the escrow's day.
  assert.ok(selectQualifyingRun([run({ start_date: "2026-07-16T00:00:00Z" })], POLICY));
});

test("rejects what cannot be trusted, each for its own stated reason", () => {
  const cases: [Partial<StravaActivity>, string][] = [
    [{ sport_type: "Ride" }, "NO_RUN_TODAY"],
    [{ manual: true }, "MANUAL_ACTIVITY"],
    [{ trainer: true }, "TRAINER_ACTIVITY"],
    [{ flagged: true }, "FLAGGED_ACTIVITY"],
    [{ start_latlng: [] }, "NO_GPS"],
    [{ start_latlng: null }, "NO_GPS"],
    [{ distance: 499 }, "DISTANCE_TOO_SHORT"],
    [{ moving_time: 0 }, "INVALID_MOTION"],
    [{ moving_time: 600, elapsed_time: 599 }, "INVALID_MOTION"],
    [{ distance: 5_000, moving_time: 100, elapsed_time: 100 }, "IMPLAUSIBLE_SPEED"],
    [{ distance: 600, moving_time: 1_300, elapsed_time: 1_300 }, "IMPLAUSIBLE_PACE"],
    [{ distance: 5_000, moving_time: 600, elapsed_time: 3_301 }, "IMPLAUSIBLE_ELAPSED_TIME"],
  ];
  for (const [overrides, code] of cases) {
    assert.throws(
      () => selectQualifyingRun([run(overrides)], POLICY),
      (e: unknown) => e instanceof StravaActivityError && e.code === code,
      `expected ${code} for ${JSON.stringify(overrides)}`,
    );
  }
});

test("an empty day says so rather than failing obscurely", () => {
  assert.throws(
    () => selectQualifyingRun([], POLICY),
    (e: unknown) => e instanceof StravaActivityError && e.code === "NO_ACTIVITY_TODAY",
  );
});

test("accepts the legacy `type` field when sport_type is absent", () => {
  const { sport_type: _drop, ...legacy } = run();
  assert.ok(selectQualifyingRun([{ ...legacy, type: "Run" } as StravaActivity], POLICY));
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { buildSocialLeaderboards, utcWeekStartDay, type ScoreDayEvent } from "../src/social-score";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CAROL = "0x3333333333333333333333333333333333333333" as Address;
const WEEK_NOW = Date.UTC(2026, 6, 15, 12);
const MONDAY = utcWeekStartDay(WEEK_NOW);

test("uses a Monday-to-Monday UTC week", () => {
  assert.equal(new Date(MONDAY * 86_400_000).toISOString(), "2026-07-13T00:00:00.000Z");
  assert.equal(utcWeekStartDay(Date.UTC(2026, 6, 19, 23, 59)), MONDAY);
  assert.equal(utcWeekStartDay(Date.UTC(2026, 6, 20)), MONDAY + 7);
});

test("awards at most ten overall points per wallet and UTC day", () => {
  const scoreEvents: Array<ScoreDayEvent & { stake?: number; metric?: number }> = [
    { account: ALICE, utcDay: MONDAY, stake: 1, metric: 5_000 },
    { account: ALICE, utcDay: MONDAY, stake: 100, metric: 50_000 },
    { account: ALICE, utcDay: MONDAY + 1 },
    { account: BOB, utcDay: MONDAY },
  ];
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents,
    missionEvents: [],
  });

  assert.deepEqual(data.leaderboards.overall.map(({ account, weeklyScore, weeklyVerifiedDays }) => ({ account, weeklyScore, weeklyVerifiedDays })), [
    { account: ALICE, weeklyScore: 20, weeklyVerifiedDays: 2 },
    { account: BOB, weeklyScore: 10, weeklyVerifiedDays: 1 },
  ]);
});

test("keeps Running and Learning independent while overall stays deduplicated", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [
      { account: ALICE, utcDay: MONDAY },
      { account: ALICE, utcDay: MONDAY },
    ],
    missionEvents: [
      { account: ALICE, missionType: 1, utcDay: MONDAY },
      { account: ALICE, missionType: 1, utcDay: MONDAY },
    ],
  });

  // Two runs on one UTC day are still ten points: the table counts days, not activities.
  assert.equal(data.leaderboards.overall[0].weeklyScore, 10);
  assert.equal(data.leaderboards.running[0].weeklyScore, 10);
});

test("shows category all-time points, total Lock Score and the latest optional handle", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [
      { account: ALICE, utcDay: MONDAY - 8 },
      { account: ALICE, utcDay: MONDAY },
    ],
    missionEvents: [
      { account: ALICE, missionType: 1, utcDay: MONDAY - 8 },
      { account: ALICE, missionType: 1, utcDay: MONDAY },
    ],
    handleEvents: [
      { account: ALICE, handle: "alice_old" },
      { account: ALICE, handle: "alice" },
    ],
  });

  assert.deepEqual(data.leaderboards.running[0], {
    account: ALICE,
    handle: "alice",
    weeklyScore: 10,
    weeklyVerifiedDays: 1,
    allTimeScore: 20,
    allTimeVerifiedDays: 2,
    lockScore: 20,
  });
});

test("does not carry inactive players into a new weekly table", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [{ account: ALICE, utcDay: MONDAY - 1 }],
    missionEvents: [{ account: ALICE, missionType: 1, utcDay: MONDAY - 1 }],
  });

  assert.deepEqual(data.leaderboards.overall, []);
  assert.deepEqual(data.leaderboards.running, []);
});

test("moderation hides only the active handle and can restore it without changing score", () => {
  const base = {
    now: WEEK_NOW,
    scoreEvents: [{ account: ALICE, utcDay: MONDAY }],
    missionEvents: [{ account: ALICE, missionType: 1, utcDay: MONDAY }],
    handleEvents: [{ account: ALICE, handle: "alice" }],
  };

  const hidden = buildSocialLeaderboards({ ...base, visibilityEvents: [{ account: ALICE, hidden: true }] });
  assert.equal(hidden.leaderboards.overall[0].handle, null);
  assert.equal(hidden.leaderboards.overall[0].weeklyScore, 10);

  const restored = buildSocialLeaderboards({
    ...base,
    visibilityEvents: [{ account: ALICE, hidden: true }, { account: ALICE, hidden: false }],
  });
  assert.equal(restored.leaderboards.overall[0].handle, "alice");
  assert.equal(restored.leaderboards.overall[0].weeklyScore, 10);
});

test("a Duolingo completion appears in Learning and in Overall, not Running", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [],
    missionEvents: [],
    completionEvents: [{ account: ALICE, utcDay: MONDAY }],
  });
  assert.equal(data.leaderboards.learning[0].account, ALICE);
  assert.equal(data.leaderboards.learning[0].weeklyScore, 10);
  assert.equal(data.leaderboards.overall[0].account, ALICE);
  assert.equal(data.leaderboards.overall[0].weeklyScore, 10);
  assert.deepEqual(data.leaderboards.running, []);
});

test("two Duolingo completions on one UTC day are still ten points", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [],
    missionEvents: [],
    completionEvents: [{ account: ALICE, utcDay: MONDAY }, { account: ALICE, utcDay: MONDAY }],
  });
  assert.equal(data.leaderboards.learning[0].weeklyScore, 10);
  assert.equal(data.leaderboards.learning[0].weeklyVerifiedDays, 1);
  assert.equal(data.leaderboards.overall[0].weeklyScore, 10);
});

test("a Strava check-in and a Duolingo completion on the same day are ten Overall points", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [{ account: ALICE, utcDay: MONDAY }],
    missionEvents: [{ account: ALICE, missionType: 1, utcDay: MONDAY }],
    completionEvents: [{ account: ALICE, utcDay: MONDAY }],
  });
  assert.equal(data.leaderboards.overall[0].weeklyScore, 10);
  assert.equal(data.leaderboards.overall[0].weeklyVerifiedDays, 1);
});

test("a Strava check-in and a Duolingo completion on the same day each show in their own category", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [{ account: ALICE, utcDay: MONDAY }],
    missionEvents: [{ account: ALICE, missionType: 1, utcDay: MONDAY }],
    completionEvents: [{ account: ALICE, utcDay: MONDAY }],
  });
  assert.equal(data.leaderboards.running[0].weeklyScore, 10);
  assert.equal(data.leaderboards.learning[0].weeklyScore, 10);
});

test("two distinct verified days are twenty points", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [],
    missionEvents: [],
    completionEvents: [{ account: ALICE, utcDay: MONDAY }, { account: ALICE, utcDay: MONDAY + 1 }],
  });
  assert.equal(data.leaderboards.learning[0].weeklyScore, 20);
  assert.equal(data.leaderboards.learning[0].weeklyVerifiedDays, 2);
  assert.equal(data.leaderboards.overall[0].weeklyScore, 20);
});

test("a Duolingo wallet with no handle keeps its address for the compact display", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [],
    missionEvents: [],
    completionEvents: [{ account: CAROL, utcDay: MONDAY }],
  });
  assert.equal(data.leaderboards.learning[0].handle, null);
  assert.equal(data.leaderboards.learning[0].account, CAROL);
});

test("the Learning board is empty when there are no completions", () => {
  const data = buildSocialLeaderboards({
    now: WEEK_NOW,
    scoreEvents: [{ account: ALICE, utcDay: MONDAY }],
    missionEvents: [{ account: ALICE, missionType: 1, utcDay: MONDAY }],
  });
  assert.deepEqual(data.leaderboards.learning, []);
});

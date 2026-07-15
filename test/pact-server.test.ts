import assert from "node:assert/strict";
import test from "node:test";
import { proofSubmissionDeadlineMs } from "../src/pact-server.js";
import { DUOLINGO_XP_MISSION, STRAVA_RUN_MISSION } from "../src/lock-in-abi.js";

test("keeps the grace window for Strava uploads but not fresh Duolingo snapshots", () => {
  const dayEnd = 1_800_000_000_000;
  assert.equal(proofSubmissionDeadlineMs(STRAVA_RUN_MISSION, dayEnd), dayEnd + 24 * 60 * 60 * 1_000);
  assert.equal(proofSubmissionDeadlineMs(DUOLINGO_XP_MISSION, dayEnd), dayEnd);
});

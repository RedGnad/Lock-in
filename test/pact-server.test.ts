import assert from "node:assert/strict";
import test from "node:test";
import { proofSubmissionDeadlineMs } from "../src/pact-server.js";
import { STRAVA_RUN_MISSION } from "../src/lock-in-abi.js";

test("a Strava day stays submittable for a full grace window after it ends", () => {
  // Strava uploads late: a watch that syncs the next morning must not cost the athlete their day. The
  // escrow enforces the same SUBMISSION_GRACE_PERIOD on chain.
  const dayEnd = 1_800_000_000_000;
  assert.equal(proofSubmissionDeadlineMs(STRAVA_RUN_MISSION, dayEnd), dayEnd + 24 * 60 * 60 * 1_000);
});

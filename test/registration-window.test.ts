import assert from "node:assert/strict";
import test from "node:test";
import {
  REGISTRATION_WINDOW_SECONDS,
  scheduledDuolingoStart,
  scheduledStravaStart,
} from "../src/registration-window.js";

test("both missions keep at least a two-and-a-half-hour registration window", () => {
  const minimum = BigInt(REGISTRATION_WINDOW_SECONDS);

  for (const chainTimestamp of [0n, 1n, 299n, 899n, 1_800_000_000n]) {
    assert.ok(scheduledStravaStart(chainTimestamp) - chainTimestamp >= minimum);
    assert.ok(scheduledDuolingoStart(chainTimestamp) - chainTimestamp >= minimum);
  }
});

test("rounding stays safely inside each deployed contract's start-delay limit", () => {
  const stravaRoundingLimit = BigInt(REGISTRATION_WINDOW_SECONDS + 15 * 60);
  const duolingoRoundingLimit = BigInt(REGISTRATION_WINDOW_SECONDS + 5 * 60);

  for (const chainTimestamp of [0n, 1n, 299n, 899n, 1_800_000_000n]) {
    const stravaDelay = scheduledStravaStart(chainTimestamp) - chainTimestamp;
    const duolingoDelay = scheduledDuolingoStart(chainTimestamp) - chainTimestamp;
    assert.ok(stravaDelay < stravaRoundingLimit);
    assert.ok(stravaDelay < 3n * 60n * 60n);
    assert.ok(duolingoDelay < duolingoRoundingLimit);
    assert.ok(duolingoDelay < 24n * 60n * 60n);
  }
});

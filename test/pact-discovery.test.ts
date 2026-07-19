import assert from "node:assert/strict";
import test from "node:test";
import { parseLockDestination } from "../components/pact-discovery.js";
import { encodeLockInviteCode } from "../src/lock-invite.js";

test("Duolingo discovery accepts a short code and the shared URL", () => {
  assert.deepEqual(parseLockDestination("DUO-2"), { mission: "duolingo", id: 2n });
  assert.deepEqual(parseLockDestination("duolingo:42"), { mission: "duolingo", id: 42n });
  assert.deepEqual(
    parseLockDestination("https://lock-in.quest/duolingo?lock=2"),
    { mission: "duolingo", id: 2n },
  );
  assert.deepEqual(parseLockDestination("/duolingo?lock=7"), { mission: "duolingo", id: 7n });
});

test("existing Strava IDs and invite codes keep their routing", () => {
  assert.deepEqual(parseLockDestination("2"), { mission: "strava", id: 2n });
  assert.deepEqual(parseLockDestination(encodeLockInviteCode(12n)), { mission: "strava", id: 12n });
});

test("ambiguous and malformed Duolingo destinations are rejected", () => {
  for (const value of ["DUO-0", "DUO-", "/duolingo?lock=0", "/duolingo?lock=nope"]) {
    assert.equal(parseLockDestination(value), null);
  }
});

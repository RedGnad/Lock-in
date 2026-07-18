// The Duolingo proof is polled while Reclaim works. The bug: the poll shared the tight one-shot `verify`
// budget (10 / 10 min), so a slow login tripped our own 429 after ~10 polls and aborted the flow. The fix
// splits the budgets: every poll uses the generous `status` budget, and the tight `verify` budget applies
// only when a real verification runs (the poll that finds a completed proof). These tests pin that split.

import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter, rateLimitPolicies } from "../src/rate-limit.js";

test("15 to 20 successive pending polls never produce a 429 (status budget)", () => {
  const status = new FixedWindowRateLimiter(rateLimitPolicies.status);
  const key = "0xwallet:203.0.113.7";
  for (let i = 1; i <= 20; i += 1) {
    assert.equal(status.check(key).allowed, true, `pending poll ${i} must be allowed`);
  }
  assert.ok(rateLimitPolicies.status.limit >= 120, "the polling budget must comfortably exceed a 10-min poll");
});

test("the verify budget is tight and separate, so it only bounds real verifications", () => {
  const verify = new FixedWindowRateLimiter(rateLimitPolicies.verify);
  const key = "0xwallet:203.0.113.7";
  // A completed proof reaches this budget at most once per session (the session is single-use), so ten is
  // plenty; the eleventh is limited, which never happens during normal pending polling.
  for (let i = 1; i <= 10; i += 1) assert.equal(verify.check(key).allowed, true, `verification ${i} allowed`);
  assert.equal(verify.check(key).allowed, false, "the eleventh real verification is limited");
  assert.equal(rateLimitPolicies.verify.limit, 10);
});

test("a denied poll reports a positive Retry-After so the client can wait instead of aborting", () => {
  const verify = new FixedWindowRateLimiter(rateLimitPolicies.verify);
  const key = "0xwallet:203.0.113.7";
  for (let i = 0; i < 10; i += 1) verify.check(key);
  const denied = verify.check(key);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 1, "Retry-After must be at least one second");
});

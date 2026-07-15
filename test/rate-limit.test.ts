import assert from "node:assert/strict";
import test from "node:test";
import {
  clientIpFromRequest,
  FixedWindowRateLimiter,
  rateLimitKeyForRequest,
  rateLimitResponseHeaders,
} from "../src/rate-limit.js";

test("allows the configured number of requests and returns a retry delay", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({
    limit: 2,
    windowMs: 10_000,
    maxEntries: 10,
    now: () => now,
  });

  assert.deepEqual(limiter.check("client"), {
    allowed: true,
    limit: 2,
    remaining: 1,
    resetAtMs: 11_000,
    retryAfterSeconds: 0,
  });
  assert.equal(limiter.check("client").allowed, true);

  now = 1_001;
  const blocked = limiter.check("client");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 10);
  assert.equal(rateLimitResponseHeaders(blocked)["Retry-After"], "10");
});

test("starts a fresh bucket at the fixed-window boundary", () => {
  let now = 500;
  const limiter = new FixedWindowRateLimiter({
    limit: 1,
    windowMs: 1_000,
    maxEntries: 2,
    now: () => now,
  });

  assert.equal(limiter.check("client").allowed, true);
  assert.equal(limiter.check("client").allowed, false);
  now = 1_500;
  assert.equal(limiter.check("client").allowed, true);
  assert.equal(limiter.check("client").resetAtMs, 2_500);
});

test("keeps its in-memory key set bounded", () => {
  const limiter = new FixedWindowRateLimiter({
    limit: 1,
    windowMs: 60_000,
    maxEntries: 2,
    now: () => 0,
  });

  limiter.check("first");
  limiter.check("second");
  limiter.check("third");
  assert.equal(limiter.size, 2);
  assert.equal(limiter.check("first").allowed, true, "the oldest bucket was evicted");
  assert.equal(limiter.size, 2);
});

test("uses Vercel's client IP header first and rejects malformed values", () => {
  const vercelRequest = new Request("https://lock-in.test", {
    headers: {
      "x-vercel-forwarded-for": "2001:db8::1",
      "x-forwarded-for": "203.0.113.8, 10.0.0.1",
    },
  });
  assert.equal(clientIpFromRequest(vercelRequest), "2001:db8::1");

  const fallbackRequest = new Request("https://lock-in.test", {
    headers: {
      "x-vercel-forwarded-for": "not-an-ip",
      "x-forwarded-for": "198.51.100.7, attacker-controlled-text",
    },
  });
  assert.equal(clientIpFromRequest(fallbackRequest), "198.51.100.7");

  const unknownRequest = new Request("https://lock-in.test", {
    headers: { "x-forwarded-for": "arbitrary-unbounded-key" },
  });
  assert.equal(clientIpFromRequest(unknownRequest), "unknown");
  assert.notEqual(
    rateLimitKeyForRequest(vercelRequest, "signed-session-a"),
    rateLimitKeyForRequest(vercelRequest, "signed-session-b"),
    "two signed sessions on one Wi-Fi must not share a polling bucket",
  );
  assert.equal(
    rateLimitKeyForRequest(vercelRequest, "signed-session-a"),
    rateLimitKeyForRequest(vercelRequest, "signed-session-a"),
  );
});

test("validates limiter configuration", () => {
  assert.throws(
    () => new FixedWindowRateLimiter({ limit: 0, windowMs: 1, maxEntries: 1 }),
    /limit must be a positive integer/,
  );
  assert.throws(
    () => new FixedWindowRateLimiter({ limit: 1, windowMs: 0, maxEntries: 1 }),
    /windowMs must be a positive integer/,
  );
  assert.throws(
    () => new FixedWindowRateLimiter({ limit: 1, windowMs: 1, maxEntries: 0 }),
    /maxEntries must be a positive integer/,
  );
});

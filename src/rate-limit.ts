import { isIP } from "node:net";
import { createHash } from "node:crypto";

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
};

export type FixedWindowRateLimiterOptions = {
  limit: number;
  windowMs: number;
  maxEntries: number;
  now?: () => number;
};

type WindowEntry = {
  count: number;
  resetAtMs: number;
};

/**
 * A deliberately small, in-memory fixed-window limiter.
 *
 * It is useful as a best-effort guard in a warm Vercel function instance. It
 * is not shared between instances or regions and resets on a cold start, so a
 * distributed store or Vercel Firewall must replace/supplement it at scale.
 */
export class FixedWindowRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxEntries: number;

  private readonly entries = new Map<string, WindowEntry>();
  private readonly now: () => number;

  constructor({ limit, windowMs, maxEntries, now = Date.now }: FixedWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be a positive integer");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  check(key: string): RateLimitDecision {
    const nowMs = this.now();
    let entry = this.entries.get(key);

    if (!entry || nowMs >= entry.resetAtMs) {
      if (entry) this.entries.delete(key);
      // Avoid an O(n) sweep for every first-seen client. Expired buckets only
      // need pruning when the bounded map is about to evict a live bucket.
      if (this.entries.size >= this.maxEntries) {
        this.pruneExpired(nowMs);
        this.makeRoom();
      }
      entry = { count: 0, resetAtMs: nowMs + this.windowMs };
      this.entries.set(key, entry);
    }

    if (entry.count >= this.limit) {
      return this.decision(false, entry, nowMs);
    }

    entry.count += 1;
    return this.decision(true, entry, nowMs);
  }

  clear(): void {
    this.entries.clear();
  }

  private decision(allowed: boolean, entry: WindowEntry, nowMs: number): RateLimitDecision {
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((entry.resetAtMs - nowMs) / 1_000));
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetAtMs: entry.resetAtMs,
      retryAfterSeconds,
    };
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAtMs > nowMs) continue;
      this.entries.delete(key);
    }
  }

  private makeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }
}

function firstValidIp(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.split(",", 1)[0]?.trim();
  if (!candidate || isIP(candidate) === 0) return null;
  return candidate.toLowerCase();
}

/**
 * Vercel documents x-vercel-forwarded-for as its stable client-IP header. The
 * standard header and x-real-ip are fallbacks for local or alternate hosting.
 * Malformed values are never used as attacker-controlled map keys.
 */
export function clientIpFromRequest(request: Request): string {
  return (
    firstValidIp(request.headers.get("x-vercel-forwarded-for")) ||
    firstValidIp(request.headers.get("x-forwarded-for")) ||
    firstValidIp(request.headers.get("x-real-ip")) ||
    "unknown"
  );
}

export const reclaimRateLimitPolicies = {
  access: { limit: 10, windowMs: 10 * 60_000, maxEntries: 5_000 },
  session: { limit: 30, windowMs: 10 * 60_000, maxEntries: 5_000 },
  status: { limit: 180, windowMs: 10 * 60_000, maxEntries: 10_000 },
  verify: { limit: 10, windowMs: 10 * 60_000, maxEntries: 5_000 },
} as const;

export type ReclaimRateLimitKind = keyof typeof reclaimRateLimitPolicies;

const reclaimLimiters: Record<ReclaimRateLimitKind, FixedWindowRateLimiter> = {
  access: new FixedWindowRateLimiter(reclaimRateLimitPolicies.access),
  session: new FixedWindowRateLimiter(reclaimRateLimitPolicies.session),
  status: new FixedWindowRateLimiter(reclaimRateLimitPolicies.status),
  verify: new FixedWindowRateLimiter(reclaimRateLimitPolicies.verify),
};

export function checkReclaimRateLimit(
  kind: ReclaimRateLimitKind,
  request: Request,
  signedScope?: string,
): RateLimitDecision {
  return reclaimLimiters[kind].check(rateLimitKeyForRequest(request, signedScope));
}

export function rateLimitKeyForRequest(request: Request, signedScope?: string): string {
  const ip = clientIpFromRequest(request);
  if (!signedScope) return ip;
  const scopeHash = createHash("sha256").update(signedScope).digest("hex").slice(0, 24);
  return `${ip}:${scopeHash}`;
}

export function rateLimitResponseHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Retry-After": String(decision.retryAfterSeconds),
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.ceil(decision.resetAtMs / 1_000)),
  };
}

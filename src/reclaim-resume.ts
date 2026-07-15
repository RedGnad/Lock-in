export const RECLAIM_RESUME_VERSION = 1;
export const RECLAIM_RESUME_MAX_AGE_MS = 20 * 60 * 1_000;

const CLOCK_SKEW_MS = 60 * 1_000;

export type ReclaimResumeSession = {
  version: typeof RECLAIM_RESUME_VERSION;
  token: string;
  sessionId: string;
  dayIndex: number;
  pactId: string;
  walletAddress: string;
  challenge: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ReclaimResumeContext = {
  pactId: string;
  walletAddress: string;
  challenge: string;
  durationDays: number;
};

export type ReclaimResumeValidation =
  | { ok: true; session: ReclaimResumeSession }
  | { ok: false; reason: "malformed" | "expired" | "wallet" | "pact" | "challenge" | "day" };

type TokenClaims = {
  sessionId: string;
  walletAddress: string;
  pactId: string;
  dayIndex: number;
  challenge: string;
  exp: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function tokenClaims(token: string): TokenClaims | null {
  try {
    if (token.length === 0 || token.length > 16 * 1_024) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const payload = JSON.parse(decodeBase64Url(parts[0]));
    if (!isRecord(payload)) return null;
    if (
      typeof payload.sessionId !== "string" ||
      typeof payload.walletAddress !== "string" ||
      typeof payload.pactId !== "string" ||
      typeof payload.challenge !== "string" ||
      !Number.isSafeInteger(payload.dayIndex) ||
      !Number.isSafeInteger(payload.exp)
    ) return null;
    return payload as TokenClaims;
  } catch {
    return null;
  }
}

function normalizedWallet(value: string): string | null {
  return /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function canonicalPactId(value: string): string | null {
  try {
    return /^\d+$/.test(value) ? BigInt(value).toString() : null;
  } catch {
    return null;
  }
}

export function reclaimResumeStorageKey(pactId: string): string {
  const canonical = canonicalPactId(pactId);
  return `lock-in-reclaim-session:${canonical || "invalid"}`;
}

export function createReclaimResumeSession(input: {
  token: string;
  sessionId: string;
  dayIndex: number;
  pactId: string;
  walletAddress: string;
  challenge: string;
  durationDays: number;
}, nowMs = Date.now()): ReclaimResumeSession | null {
  const claims = tokenClaims(input.token);
  if (!claims) return null;
  const { durationDays, ...sessionInput } = input;
  const session: ReclaimResumeSession = {
    version: RECLAIM_RESUME_VERSION,
    ...sessionInput,
    pactId: canonicalPactId(input.pactId) || input.pactId,
    walletAddress: input.walletAddress.toLowerCase(),
    createdAtMs: nowMs,
    expiresAtMs: claims.exp,
  };
  const validation = validateReclaimResumeSession(session, {
    pactId: input.pactId,
    walletAddress: input.walletAddress,
    challenge: input.challenge,
    durationDays,
  }, nowMs);
  return validation.ok ? validation.session : null;
}

export function validateReclaimResumeSession(
  value: unknown,
  context: ReclaimResumeContext,
  nowMs = Date.now(),
): ReclaimResumeValidation {
  if (!isRecord(value)) return { ok: false, reason: "malformed" };
  const session = value as Partial<ReclaimResumeSession>;
  if (
    session.version !== RECLAIM_RESUME_VERSION ||
    typeof session.token !== "string" ||
    typeof session.sessionId !== "string" ||
    typeof session.pactId !== "string" ||
    typeof session.walletAddress !== "string" ||
    typeof session.challenge !== "string" ||
    typeof session.dayIndex !== "number" || !Number.isSafeInteger(session.dayIndex) ||
    typeof session.createdAtMs !== "number" || !Number.isSafeInteger(session.createdAtMs) ||
    typeof session.expiresAtMs !== "number" || !Number.isSafeInteger(session.expiresAtMs)
  ) return { ok: false, reason: "malformed" };

  const claims = tokenClaims(session.token);
  const wallet = normalizedWallet(session.walletAddress);
  const contextWallet = normalizedWallet(context.walletAddress);
  const pactId = canonicalPactId(session.pactId);
  const contextPactId = canonicalPactId(context.pactId);
  if (!claims || !wallet || !contextWallet || !pactId || !contextPactId) {
    return { ok: false, reason: "malformed" };
  }

  if (
    session.createdAtMs > nowMs + CLOCK_SKEW_MS ||
    nowMs - session.createdAtMs > RECLAIM_RESUME_MAX_AGE_MS ||
    session.expiresAtMs <= nowMs ||
    session.expiresAtMs !== claims.exp ||
    session.expiresAtMs < session.createdAtMs ||
    session.expiresAtMs - session.createdAtMs > RECLAIM_RESUME_MAX_AGE_MS + CLOCK_SKEW_MS
  ) return { ok: false, reason: "expired" };

  if (wallet !== contextWallet || normalizedWallet(claims.walletAddress) !== contextWallet) {
    return { ok: false, reason: "wallet" };
  }
  if (
    pactId !== contextPactId ||
    canonicalPactId(claims.pactId) !== contextPactId
  ) return { ok: false, reason: "pact" };
  if (session.challenge !== context.challenge || claims.challenge !== context.challenge) {
    return { ok: false, reason: "challenge" };
  }
  if (
    session.sessionId.length === 0 ||
    session.sessionId !== claims.sessionId ||
    session.dayIndex !== claims.dayIndex ||
    session.dayIndex < 0 ||
    session.dayIndex >= context.durationDays
  ) return { ok: false, reason: "day" };

  return { ok: true, session: session as ReclaimResumeSession };
}

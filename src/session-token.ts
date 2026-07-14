import { createHmac, timingSafeEqual } from "node:crypto";
import { dailyProofCode } from "./pact-code";

export type ProofSessionToken = {
  sessionId: string;
  walletAddress: string;
  pactId: string;
  dayIndex: number;
  challenge: string;
  proofCode: string;
  startsAtMs: number;
  endsAtMs: number;
  minDistanceMeters: number;
  claimDeadlineMs: number;
  exp: number;
};

function secret(): string {
  const value = process.env.SESSION_SIGNING_SECRET?.trim();
  if (!value || value.length < 32) throw new Error("SESSION_SIGNING_SECRET must contain at least 32 characters");
  return value;
}

function signature(encoded: string): string {
  return createHmac("sha256", secret()).update(encoded).digest("base64url");
}

export function issueProofSessionToken(payload: Omit<ProofSessionToken, "exp">): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 20 * 60 * 1_000 })).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

export function verifyProofSessionToken(token: string): ProofSessionToken {
  if (token.length === 0 || token.length > 16 * 1_024) throw new Error("Malformed proof session token");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed proof session token");
  const [encoded, supplied] = parts;
  if (!encoded || !supplied) throw new Error("Malformed proof session token");
  const expected = signature(encoded);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid proof session token");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ProofSessionToken;
  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) throw new Error("Expired proof session token");
  if (
    typeof payload.sessionId !== "string" || payload.sessionId.length === 0 || payload.sessionId.length > 256 ||
    typeof payload.walletAddress !== "string" || typeof payload.pactId !== "string" ||
    typeof payload.challenge !== "string" || typeof payload.proofCode !== "string" || !Number.isSafeInteger(payload.dayIndex) ||
    !Number.isSafeInteger(payload.startsAtMs) || !Number.isSafeInteger(payload.endsAtMs) ||
    !Number.isSafeInteger(payload.minDistanceMeters) || !Number.isSafeInteger(payload.claimDeadlineMs)
  ) {
    throw new Error("Invalid proof session token payload");
  }
  if (payload.proofCode !== dailyProofCode(payload.challenge, payload.dayIndex)) {
    throw new Error("Invalid proof session daily code");
  }
  return payload;
}

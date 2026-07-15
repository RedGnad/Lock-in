import { createHmac, timingSafeEqual } from "node:crypto";

export type ProofMission = 1 | 2;
export type ProofPhase = "baseline" | "completion";
export type BaselineIntent = "create" | "join";

export type ProofSessionV5 = {
  sessionId: string;
  walletAddress: string;
  pactId: string;
  missionType: ProofMission;
  phase: ProofPhase;
  intent?: BaselineIntent;
  dayIndex?: number;
  providerId: string;
  providerVersion: string;
  ownershipCode?: string;
  proofCode?: string;
  dailyTarget: number;
  startsAtMs: number;
  endsAtMs: number;
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

export function issueProofSessionV5(payload: Omit<ProofSessionV5, "exp">): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 20 * 60_000 })).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

export function verifyProofSessionV5(token: string): ProofSessionV5 {
  if (token.length === 0 || token.length > 16 * 1_024) throw new Error("Malformed proof session token");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Malformed proof session token");
  const [encoded, supplied] = parts;
  const expected = signature(encoded);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid proof session token");

  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ProofSessionV5>;
  if (
    typeof value.sessionId !== "string" || value.sessionId.length < 8 || value.sessionId.length > 256
      || typeof value.walletAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.walletAddress)
      || typeof value.pactId !== "string" || !/^\d+$/.test(value.pactId)
      || (value.missionType !== 1 && value.missionType !== 2)
      || (value.phase !== "baseline" && value.phase !== "completion")
      || typeof value.providerId !== "string" || value.providerId.length < 8
      || typeof value.providerVersion !== "string" || value.providerVersion.length < 3
      || !Number.isSafeInteger(value.dailyTarget) || Number(value.dailyTarget) <= 0
      || !Number.isSafeInteger(value.startsAtMs) || !Number.isSafeInteger(value.endsAtMs)
      || !Number.isSafeInteger(value.exp) || Number(value.exp) <= Date.now()
  ) throw new Error("Invalid proof session token payload");
  if (value.phase === "baseline" && value.missionType !== 2) throw new Error("Only Duolingo uses a baseline");
  if (value.phase === "baseline" && value.intent !== "create" && value.intent !== "join") {
    throw new Error("Invalid baseline intent");
  }
  if (value.phase === "completion" && (!Number.isSafeInteger(value.dayIndex) || Number(value.dayIndex) < 0 || Number(value.dayIndex) > 29)) {
    throw new Error("Invalid completion day");
  }
  return value as ProofSessionV5;
}

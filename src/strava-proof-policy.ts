import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
} from "viem";

export const STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
export const STRAVA_PROVIDER_VERSION = "1.0.1";
export const STRAVA_PROVIDER_KEY = keccak256(stringToHex(`${STRAVA_PROVIDER_ID}@${STRAVA_PROVIDER_VERSION}`));
export const STRAVA_PROVIDER_HASHES = [
  "0xdbb40a205e1a2036ccd2b371eebc19d6e01ae3a9b2cfd414d4d7abfbd9d11f67",
  "0x5c93d136e5aa70f1b170f12a0eda9720f3e7c3436b0956e9bd59a85059d1db24",
  "0xacaa6d30e913b76499b4f06db6c7feca367c0c925c4d5ef55fb836f27922e1d0",
  "0x5c82d40177d4abaf29329b0c9dccb8eb06a8eb4882ea2b736d3ac5a9631521bf",
] as const;
export const STRAVA_CHALLENGE_PATTERN = /^LI-[A-Z0-9]{16,32}$/;

const REQUIRED_FIELDS = [
  "marker",
  "id",
  "name",
  "type",
  "time",
  "raw",
  "latlng",
  "trainer",
] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

export type ReclaimTrustedData = {
  context: Record<string, unknown>;
  extractedParameters: Record<string, string>;
};

export type StravaPactPolicy = {
  walletAddress: string;
  pactId: string;
  dayIndex: number;
  challenge: string;
  expectedSessionId: string;
  startsAtMs: number;
  endsAtMs: number;
  minDistanceMeters: number;
};

export type StravaEvidence = {
  athleteId: string;
  activityId: string;
  activityName: string;
  sportType: "Run";
  startTime: string;
  startTimeMs: number;
  distanceMeters: number;
  hasGps: true;
  trainer: false;
  sessionId: string;
  nullifier: `0x${string}`;
};

export class StravaPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StravaPolicyError";
  }
}

function reject(code: string, message: string): never {
  throw new StravaPolicyError(code, message);
}

function contextString(
  context: Record<string, unknown>,
  key: string,
): string {
  const value = context[key];
  if (typeof value !== "string" || value.length === 0) {
    return reject("INVALID_CONTEXT", `Missing signed context field ${key}`);
  }
  return value;
}

function collectFields(data: readonly ReclaimTrustedData[]): Record<RequiredField, string> {
  const collected = new Map<string, string>();

  for (const item of data) {
    for (const [key, value] of Object.entries(item.extractedParameters)) {
      if (!REQUIRED_FIELDS.includes(key as RequiredField)) continue;
      const previous = collected.get(key);
      if (previous !== undefined && previous !== value) {
        reject("CONFLICTING_FIELD", `Conflicting signed values for ${key}`);
      }
      collected.set(key, value);
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!collected.has(field)) {
      reject("MISSING_FIELD", `Missing signed Strava field ${field}`);
    }
  }

  return Object.fromEntries(collected) as Record<RequiredField, string>;
}

function parseUtcTimestamp(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{4})$/.exec(value);
  if (!match) reject("INVALID_START_TIME", "Strava start_time has an unexpected format");

  const normalized = match[7] === "Z"
    ? value
    : `${value.slice(0, -5)}${value.slice(-5, -2)}:${value.slice(-2)}`;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    reject("INVALID_START_TIME", "Strava start_time is not a valid timestamp");
  }
  return timestamp;
}

function assertSharedContext(
  data: readonly ReclaimTrustedData[],
  policy: StravaPactPolicy,
): void {
  if (!isAddress(policy.walletAddress)) {
    reject("INVALID_POLICY", "The expected wallet address is invalid");
  }
  if (!/^\d+$/.test(policy.pactId)) {
    reject("INVALID_POLICY", "The pact ID must be an unsigned integer");
  }
  if (!Number.isSafeInteger(policy.dayIndex) || policy.dayIndex < 0 || policy.dayIndex > 4) {
    reject("INVALID_POLICY", "The day index must be between 0 and 4");
  }
  if (!STRAVA_CHALLENGE_PATTERN.test(policy.challenge)) {
    reject("INVALID_POLICY", "The challenge must match LI- followed by 16 to 32 uppercase letters or digits");
  }
  if (!Number.isSafeInteger(policy.minDistanceMeters) || policy.minDistanceMeters <= 0) {
    reject("INVALID_POLICY", "The minimum distance must be a positive integer number of meters");
  }
  if (!Number.isSafeInteger(policy.startsAtMs) || !Number.isSafeInteger(policy.endsAtMs) || policy.endsAtMs < policy.startsAtMs) {
    reject("INVALID_POLICY", "The pact time window is invalid");
  }

  const expectedAddress = getAddress(policy.walletAddress).toLowerCase();
  for (const item of data) {
    const actualAddress = contextString(item.context, "contextAddress").toLowerCase();
    const pactId = contextString(item.context, "contextMessage");
    const sessionId = contextString(item.context, "reclaimSessionId");

    if (actualAddress !== expectedAddress) {
      reject("WRONG_WALLET", "The proof is bound to another wallet");
    }
    if (pactId !== `${policy.pactId}:${policy.dayIndex}`) {
      reject("WRONG_PACT_DAY", "The proof is bound to another pact or day");
    }
    if (sessionId !== policy.expectedSessionId) {
      reject("WRONG_SESSION", "The proof does not belong to the initiated Reclaim session");
    }
  }
}

export function validateStravaEvidence(
  data: readonly ReclaimTrustedData[],
  policy: StravaPactPolicy,
): StravaEvidence {
  if (data.length === 0) reject("NO_PROOFS", "No verified Reclaim data was supplied");
  assertSharedContext(data, policy);
  const fields = collectFields(data);

  const athleteMatch = /^userId:\s*(\d+)$/.exec(fields.marker);
  if (!athleteMatch) reject("INVALID_ATHLETE", "The signed Strava athlete marker is invalid");
  if (!/^\d+$/.test(fields.id)) reject("INVALID_ACTIVITY", "The signed Strava activity ID is invalid");
  if (fields.type !== "Run") reject("WRONG_SPORT", "The activity is not a run");
  if (!fields.name.includes(policy.challenge)) {
    reject("WRONG_CHALLENGE", "The activity title does not contain this pact's challenge");
  }
  if (fields.latlng !== "true") {
    reject("NO_GPS", "Strava reports no GPS trace for this activity");
  }
  if (fields.trainer !== "false") {
    reject("TRAINER_ACTIVITY", "Indoor/trainer activities are not accepted");
  }

  if (!/^\d+$/.test(fields.raw)) reject("INVALID_DISTANCE", "Strava distance_raw is not an integer");
  const distanceMeters = Number(fields.raw);
  if (!Number.isSafeInteger(distanceMeters) || distanceMeters < policy.minDistanceMeters) {
    reject("DISTANCE_TOO_SHORT", "The signed distance does not satisfy the pact");
  }

  const startTimeMs = parseUtcTimestamp(fields.time);
  if (startTimeMs < policy.startsAtMs || startTimeMs >= policy.endsAtMs) {
    reject("OUTSIDE_PACT_WINDOW", "The activity started outside the pact time window");
  }

  const nullifier = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 providerKey, string athleteMarker, uint256 activityId"),
    [STRAVA_PROVIDER_KEY, fields.marker, BigInt(fields.id)],
  ));

  return {
    athleteId: athleteMatch[1],
    activityId: fields.id,
    activityName: fields.name,
    sportType: "Run",
    startTime: fields.time,
    startTimeMs,
    distanceMeters,
    hasGps: true,
    trainer: false,
    sessionId: policy.expectedSessionId,
    nullifier,
  };
}

export function assertFreshProofTimestamps(
  timestampSeconds: readonly number[],
  nowMs = Date.now(),
  maxAgeSeconds = 10 * 60,
): void {
  if (timestampSeconds.length === 0) reject("NO_PROOFS", "No proof timestamps were supplied");
  const nowSeconds = Math.floor(nowMs / 1_000);
  for (const timestamp of timestampSeconds) {
    if (!Number.isSafeInteger(timestamp)) reject("INVALID_PROOF_TIME", "A proof timestamp is invalid");
    if (timestamp > nowSeconds + 60) reject("PROOF_FROM_FUTURE", "A proof timestamp is in the future");
    if (nowSeconds - timestamp > maxAgeSeconds) reject("STALE_PROOF", "The proof is too old");
  }
}

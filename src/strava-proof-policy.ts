import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
} from "viem";
import type { Proof } from "@reclaimprotocol/js-sdk";
import { STRAVA_PACT_CHALLENGE_PATTERN } from "./pact-code";

export const STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
export const STRAVA_PROVIDER_VERSION = "7.0.0";
export const STRAVA_PROVIDER_KEY = keccak256(stringToHex(`${STRAVA_PROVIDER_ID}@${STRAVA_PROVIDER_VERSION}`));
/** The 7.0.0 provider returns exactly two claims: the athlete marker, then the combined activity. */
export const STRAVA_PROOF_COUNT = 2;
/**
 * Deterministic request hashes of the published 7.0.0 provider, in canonical request order.
 *
 * A proof context carries no `providerHash` on this provider, so these are NOT used to pin a proof (the
 * on-chain parser pins the request from `claimData.parameters`). They exist to detect drift of the LIVE
 * provider configuration before a user ever launches a proof. Both were recomputed with the SDK's
 * `hashRequestSpec` over `providers/strava-date-distance.json`; the marker request is unchanged since
 * 1.0.3 and its value still reproduces the historically pinned hash, which validates the derivation.
 * The activity hash changed with 7.0.0: its URL no longer carries the {{context_challenge}} keyword.
 */
export const STRAVA_MARKER_REQUEST_HASH =
  "0xdbb40a205e1a2036ccd2b371eebc19d6e01ae3a9b2cfd414d4d7abfbd9d11f67";
export const STRAVA_ACTIVITY_REQUEST_HASH =
  "0x59883c374d190f23e1f3891267f1fd041a369479a51aafefd45648765b359134";
export const STRAVA_REQUEST_HASHES = [STRAVA_MARKER_REQUEST_HASH, STRAVA_ACTIVITY_REQUEST_HASH] as const;
/** Reclaim classifies a provider as AI when this is "AI"; Lock In requires the witness path. */
export const STRAVA_VERIFICATION_TYPE = "WITNESS";
export const STRAVA_CHALLENGE_PATTERN = STRAVA_PACT_CHALLENGE_PATTERN;

const REQUIRED_FIELDS = [
  "marker",
  "id",
  "name",
  "type",
  "time",
  "raw",
  "flagged",
  "moving",
  "elapsed",
  "elevation",
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
  expectedSessionId: string;
  startsAtMs: number;
  endsAtMs: number;
  minDistanceMeters: number;
};

export type StravaEvidence = {
  athleteId: string;
  identityHash: `0x${string}`;
  activityId: string;
  activityName: string;
  sportType: "Run";
  startTime: string;
  startTimeMs: number;
  distanceMeters: number;
  movingTimeSeconds: number;
  elapsedTimeSeconds: number;
  elevationGainMeters: number;
  flagged: false;
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

const STRAVA_ROLES = ["marker", "activity"] as const;
type StravaRole = (typeof STRAVA_ROLES)[number];

/**
 * The provider signs no `context.providerHash`, so a claim's role is read from the shape of its
 * signed extractedParameters: the marker claim carries `marker`, the combined activity claim carries `id`.
 * This ordering only has to be deterministic. The request itself is re-pinned from `claimData.parameters`
 * (url, method, body, responseMatches, responseRedactions, paramValues) by the on-chain verifier, so a
 * claim placed in the wrong slot fails that pin rather than being trusted on the strength of its shape.
 */
function stravaRole(extracted: Record<string, unknown>): StravaRole {
  const isMarker = typeof extracted.marker === "string";
  const isActivity = typeof extracted.id === "string";
  if (isMarker === isActivity) {
    reject("WRONG_PROOF_SCHEMA", "A Strava proof does not match a pinned request schema");
  }
  return isMarker ? "marker" : "activity";
}

export function canonicalizeStravaProofs(proofs: readonly Proof[]): Proof[] {
  if (proofs.length !== STRAVA_PROOF_COUNT) {
    reject("WRONG_PROOF_COUNT", "The Strava provider must return exactly two proofs");
  }
  const byRole = new Map<StravaRole, Proof>();
  for (const proof of proofs) {
    let extracted: unknown;
    try {
      const context = JSON.parse(proof.claimData.context) as Record<string, unknown>;
      extracted = context.extractedParameters;
    } catch {
      reject("INVALID_CONTEXT", "A Strava proof contains malformed signed context");
    }
    if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
      reject("INVALID_CONTEXT", "A Strava proof carries no signed extracted parameters");
    }
    const role = stravaRole(extracted as Record<string, unknown>);
    if (byRole.has(role)) {
      reject("DUPLICATE_PROOF_SCHEMA", "The Strava proof set repeats a request schema");
    }
    byRole.set(role, proof);
  }
  return STRAVA_ROLES.map((role) => {
    const proof = byRole.get(role);
    if (!proof) return reject("MISSING_PROOF_SCHEMA", "The Strava proof set is incomplete");
    return proof;
  });
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

function canonicalUint(value: string, maxDigits: number, maximum: bigint, field: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value) || value.length > maxDigits) {
    reject(field, `The signed ${field.toLowerCase()} is not a canonical unsigned integer`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum) reject(field, `The signed ${field.toLowerCase()} is outside the accepted range`);
  return parsed;
}

function assertSharedContext(
  data: readonly ReclaimTrustedData[],
  policy: StravaPactPolicy,
): void {
  if (!isAddress(policy.walletAddress)) {
    reject("INVALID_POLICY", "The expected wallet address is invalid");
  }
  if (!/^\d+$/.test(policy.pactId)) {
    reject("INVALID_POLICY", "The lock ID must be an unsigned integer");
  }
  if (!Number.isSafeInteger(policy.dayIndex) || policy.dayIndex < 0 || policy.dayIndex > 29) {
    reject("INVALID_POLICY", "The day index must be between 0 and 29");
  }
  if (!Number.isSafeInteger(policy.minDistanceMeters) || policy.minDistanceMeters <= 0) {
    reject("INVALID_POLICY", "The minimum distance must be a positive integer number of meters");
  }
  if (!Number.isSafeInteger(policy.startsAtMs) || !Number.isSafeInteger(policy.endsAtMs) || policy.endsAtMs < policy.startsAtMs) {
    reject("INVALID_POLICY", "The lock time window is invalid");
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
      reject("WRONG_PACT_DAY", "The proof is bound to another lock or day");
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

  const athleteMatch = /^userId: (0|[1-9]\d{0,19})$/.exec(fields.marker);
  if (!athleteMatch) reject("INVALID_ATHLETE", "The signed Strava athlete marker is invalid");
  canonicalUint(fields.id, 20, (1n << 64n) - 1n, "INVALID_ACTIVITY");
  if (fields.type !== "Run") reject("WRONG_SPORT", "The activity is not a run");
  // 7.0.0 puts no constraint on the activity title: an athlete never retitles a run. The run is tied to
  // this Lock by the day window below and, on-chain, by the escrow's global activity nullifier.
  if (fields.latlng !== "true") {
    reject("NO_GPS", "Strava reports no GPS trace for this activity");
  }
  if (fields.trainer !== "false") {
    reject("TRAINER_ACTIVITY", "Indoor/trainer activities are not accepted");
  }
  if (fields.flagged !== "false") {
    reject("FLAGGED_ACTIVITY", "Activities flagged by Strava are not accepted");
  }

  const distanceMeters = Number(canonicalUint(fields.raw, 10, 1_000_000_000n, "INVALID_DISTANCE"));
  if (!Number.isSafeInteger(distanceMeters) || distanceMeters < policy.minDistanceMeters) {
    reject("DISTANCE_TOO_SHORT", "The signed distance does not satisfy the lock");
  }

  const movingTimeSeconds = Number(canonicalUint(fields.moving, 10, 1_000_000_000n, "INVALID_MOTION"));
  const elapsedTimeSeconds = Number(canonicalUint(fields.elapsed, 10, 1_000_000_000n, "INVALID_MOTION"));
  const elevationGainMeters = Number(canonicalUint(fields.elevation, 10, 1_000_000_000n, "INVALID_MOTION"));
  if (
    !Number.isSafeInteger(movingTimeSeconds) ||
    !Number.isSafeInteger(elapsedTimeSeconds) ||
    !Number.isSafeInteger(elevationGainMeters) ||
    movingTimeSeconds <= 0 ||
    elapsedTimeSeconds < movingTimeSeconds
  ) {
    reject("INVALID_MOTION", "Strava motion metrics are inconsistent");
  }
  if (distanceMeters > movingTimeSeconds * 9) {
    reject("IMPLAUSIBLE_SPEED", "The signed average speed exceeds the running limit");
  }
  if (distanceMeters * 2 < movingTimeSeconds) {
    reject("IMPLAUSIBLE_PACE", "The signed activity is too slow to count as a run");
  }
  if (elapsedTimeSeconds > movingTimeSeconds * 4 + 15 * 60) {
    reject("IMPLAUSIBLE_ELAPSED_TIME", "The signed elapsed/moving time ratio is implausible");
  }

  const startTimeMs = parseUtcTimestamp(fields.time);
  if (startTimeMs < policy.startsAtMs || startTimeMs >= policy.endsAtMs) {
    reject("OUTSIDE_PACT_WINDOW", "The activity started outside the lock time window");
  }

  const nullifier = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 providerKey, string athleteMarker, uint256 activityId"),
    [STRAVA_PROVIDER_KEY, fields.marker, BigInt(fields.id)],
  ));
  const identityHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 providerKey, string athleteMarker"),
    [STRAVA_PROVIDER_KEY, fields.marker],
  ));

  return {
    athleteId: athleteMatch[1],
    identityHash,
    activityId: fields.id,
    activityName: fields.name,
    sportType: "Run",
    startTime: fields.time,
    startTimeMs,
    distanceMeters,
    movingTimeSeconds,
    elapsedTimeSeconds,
    elevationGainMeters,
    flagged: false,
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
  if (Math.max(...timestampSeconds) - Math.min(...timestampSeconds) > 2 * 60) {
    reject("PROOF_SET_TOO_SPREAD_OUT", "The Strava proof set was not produced in one verification window");
  }
}

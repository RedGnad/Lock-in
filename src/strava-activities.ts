import { createHmac } from "node:crypto";


/**
 * Reads a Lock's run straight from Strava's own API, over the athlete's OAuth grant.
 *
 * This replaces the zkTLS path. The rules below are the SAME rules the on-chain verifier used to enforce
 * (Run, distance, GPS, not manual, not a trainer, not flagged, plausible motion, inside the Lock day), but
 * they now run on our server against Strava's answer. The trust that used to come from a witness signature
 * now comes from Strava's API plus our attestation, and that is a real, deliberate reduction.
 */

export const STRAVA_ATTESTATION_SCHEME = "STRAVA_OAUTH_V1";
const ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

export class StravaActivityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StravaActivityError";
  }
}

function reject(code: string, message: string): never {
  throw new StravaActivityError(code, message);
}

/** The subset of a Strava activity the rules below depend on. */
export type StravaActivity = Readonly<{
  id: number;
  name: string;
  sport_type?: string;
  type?: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  start_date: string;
  manual?: boolean;
  trainer?: boolean;
  flagged?: boolean;
  start_latlng?: number[] | null;
}>;

export type StravaRunEvidence = Readonly<{
  athleteId: string;
  activityId: string;
  activityName: string;
  startTimeMs: number;
  distanceMeters: number;
  movingTimeSeconds: number;
  elapsedTimeSeconds: number;
  elevationGainMeters: number;
  identityHash: `0x${string}`;
  nullifier: `0x${string}`;
  activityHash: `0x${string}`;
}>;

/**
 * Pseudonymises a Strava identifier for publication.
 *
 * keccak256 of a numeric Strava id is NOT anonymity: athlete and activity ids are small integers, so
 * anyone can enumerate them and match the hash. An HMAC under a server-held key removes that: without the
 * key the published value cannot be linked back to an account. The backend is already trusted under
 * STRAVA_OAUTH_V1, so holding this key adds no new trust assumption.
 *
 * The key must be stable: changing it changes every identity and nullifier, which would let an athlete
 * replay a run that was already spent, and would break the one-identity-per-Lock rule.
 */
function pseudonymise(kind: "athlete" | "activity" | "run", value: string): `0x${string}` {
  const key = process.env.STRAVA_TOKEN_ENCRYPTION_KEY?.trim();
  if (!key) throw new StravaActivityError("SERVER_MISCONFIGURED", "The pseudonymisation key is not configured");
  const digest = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${STRAVA_ATTESTATION_SCHEME}:${kind}:${value}`)
    .digest("hex");
  return `0x${digest}`;
}

export type StravaRunPolicy = Readonly<{
  athleteId: string;
  startsAtMs: number;
  endsAtMs: number;
  minDistanceMeters: number;
}>;

/**
 * Fetches the athlete's activities that started inside the Lock day.
 *
 * `before`/`after` are Strava's own window filter, so the day boundary is applied by Strava rather than by
 * paging the whole history. That also keeps this bounded for an athlete with years of runs.
 */
export async function fetchStravaActivities(input: {
  accessToken: string;
  startsAtMs: number;
  endsAtMs: number;
}): Promise<StravaActivity[]> {
  const url = new URL(ACTIVITIES_URL);
  // Strava's bounds are exclusive on both sides, so widen by a second to keep the window inclusive.
  url.searchParams.set("after", String(Math.floor(input.startsAtMs / 1_000) - 1));
  url.searchParams.set("before", String(Math.ceil(input.endsAtMs / 1_000) + 1));
  url.searchParams.set("per_page", "50");

  const response = await fetch(url, { headers: { Authorization: `Bearer ${input.accessToken}` } });
  if (response.status === 401) reject("STRAVA_UNAUTHORIZED", "Reconnect Strava: the authorization is no longer valid");
  if (response.status === 429) reject("STRAVA_RATE_LIMITED", "Strava is rate limiting us. Try again shortly");
  if (!response.ok) reject("STRAVA_UNAVAILABLE", `Strava returned ${response.status}`);

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) reject("STRAVA_UNAVAILABLE", "Strava returned an unexpected activity list");
  return body as StravaActivity[];
}

function isRun(activity: StravaActivity): boolean {
  return (activity.sport_type ?? activity.type) === "Run";
}

/** True when Strava recorded a GPS trace. A manual entry has no start point. */
function hasGps(activity: StravaActivity): boolean {
  return Array.isArray(activity.start_latlng) && activity.start_latlng.length === 2;
}

/**
 * Picks the qualifying run and derives the evidence the escrow will be asked to accept.
 *
 * Every rejection is specific, because the athlete has staked money and "no" without a reason is the
 * thing that makes people distrust the product.
 */
export function selectQualifyingRun(
  activities: readonly StravaActivity[],
  policy: StravaRunPolicy,
): StravaRunEvidence {
  const inWindow = activities.filter((activity) => {
    const startedAt = Date.parse(activity.start_date);
    return Number.isFinite(startedAt) && startedAt >= policy.startsAtMs && startedAt < policy.endsAtMs;
  });
  if (inWindow.length === 0) reject("NO_ACTIVITY_TODAY", "No Strava activity started inside this Lock day");

  const runs = inWindow.filter(isRun);
  if (runs.length === 0) reject("NO_RUN_TODAY", "Today's activities are not runs");

  const outdoor = runs.filter((run) => !run.manual && !run.trainer && !run.flagged && hasGps(run));
  if (outdoor.length === 0) {
    const only = runs[0];
    if (only.manual) reject("MANUAL_ACTIVITY", "A manually entered run cannot be verified");
    if (only.trainer) reject("TRAINER_ACTIVITY", "Treadmill runs are not accepted");
    if (only.flagged) reject("FLAGGED_ACTIVITY", "Strava has flagged this activity");
    reject("NO_GPS", "This run has no GPS trace");
  }

  // The longest qualifying run of the day, so a warm-up jog recorded after the real one cannot cost the
  // athlete their day.
  const best = [...outdoor].sort((a, b) => b.distance - a.distance)[0];
  const distanceMeters = Math.floor(best.distance);
  if (distanceMeters < policy.minDistanceMeters) {
    reject(
      "DISTANCE_TOO_SHORT",
      `Your longest run today is ${distanceMeters} m, and this Lock needs ${policy.minDistanceMeters} m`,
    );
  }

  const movingTimeSeconds = best.moving_time;
  const elapsedTimeSeconds = best.elapsed_time;
  if (movingTimeSeconds <= 0 || elapsedTimeSeconds < movingTimeSeconds) {
    reject("INVALID_MOTION", "Strava's motion metrics for this run are inconsistent");
  }
  // The same plausibility envelope the on-chain verifier enforced.
  if (distanceMeters > movingTimeSeconds * 9) reject("IMPLAUSIBLE_SPEED", "This run is too fast to be a run");
  if (distanceMeters * 2 < movingTimeSeconds) reject("IMPLAUSIBLE_PACE", "This run is too slow to count");
  if (elapsedTimeSeconds > movingTimeSeconds * 4 + 900) {
    reject("IMPLAUSIBLE_ELAPSED_TIME", "This run was paused for too long to count as one run");
  }

  return {
    athleteId: policy.athleteId,
    activityId: String(best.id),
    activityName: best.name,
    startTimeMs: Date.parse(best.start_date),
    distanceMeters,
    movingTimeSeconds,
    elapsedTimeSeconds,
    elevationGainMeters: Math.floor(best.total_elevation_gain ?? 0),
    // Identity is the athlete, so one Strava account maps to one participant per Lock.
    identityHash: pseudonymise("athlete", policy.athleteId),
    // The nullifier is the activity, so a single run can never be claimed twice, here or in another Lock.
    nullifier: pseudonymise("activity", String(best.id)),
    activityHash: pseudonymise(
      "run",
      `${best.id}:${distanceMeters}:${movingTimeSeconds}:${elapsedTimeSeconds}:${best.start_date}`,
    ),
  };
}

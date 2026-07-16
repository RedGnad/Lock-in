import {
  fetchProviderConfigs,
  hashRequestSpec,
  type ReclaimProviderConfig,
} from "@reclaimprotocol/js-sdk";
import {
  STRAVA_PROOF_COUNT,
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
  STRAVA_REQUEST_HASHES,
  STRAVA_VERIFICATION_TYPE,
} from "./strava-proof-policy";
import {
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  DUOLINGO_OWNERSHIP_REQUEST_HASH,
  DUOLINGO_XP_REQUEST_HASH,
} from "./duolingo-proof-policy";

/**
 * Drift gate on the LIVE Reclaim provider configuration, shared by `provider:check` and the release
 * artifact builder so a release cannot assert a weaker configuration than the pre-flight check does.
 *
 * These hashes do not pin a proof: a Strava 6.0.0 context carries no providerHash, and the on-chain
 * parser pins the request from claimData.parameters. What this catches is the live configuration
 * changing under a pinned verifier.
 */

export class ProviderConfigDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigDriftError";
  }
}

function drift(message: string): never {
  throw new ProviderConfigDriftError(message);
}

/**
 * The live API returns the version as a structured object on each provider config and does not populate
 * the response's optional top-level `providerVersionString`. The SDK types do not declare it, so it is
 * read defensively here rather than trusted.
 */
type LiveProviderVersion = {
  major?: number;
  minor?: number;
  patch?: number;
  prereleaseTag?: string | null;
  prereleaseNumber?: number | null;
};

export type LiveProviderCheck = Readonly<{
  providerId: string;
  providerVersion: string;
  verificationType: string;
  requiredRequests: number;
  requestHashes: readonly string[];
}>;

function liveVersionString(config: ReclaimProviderConfig, label: string): string {
  const version = (config as unknown as { version?: LiveProviderVersion }).version;
  if (!version || typeof version !== "object") drift(`${label}: live provider config carries no version`);
  const { major, minor, patch, prereleaseTag } = version;
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) {
    drift(`${label}: live provider version is not a semantic version`);
  }
  // A prerelease tag is how Reclaim marks an AI build (`-ai.*`). The audited providers have none.
  if (prereleaseTag !== null && prereleaseTag !== undefined) {
    drift(`${label}: live provider is a prerelease build (-${prereleaseTag}), not the audited version`);
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Asserts that the live configuration of one provider is still the deterministic, witness-verified one
 * that was audited, with the exact pinned request hashes. Throws ProviderConfigDriftError otherwise.
 */
export async function assertLiveProviderConfig(input: {
  providerId: string;
  providerVersion: string;
  expectedHashes: readonly string[];
  label: string;
}): Promise<LiveProviderCheck> {
  const { providerId, providerVersion, expectedHashes, label } = input;
  const response = await fetchProviderConfigs(providerId, providerVersion, []);
  if (response.providers?.length !== 1) {
    drift(`${label}: expected one exact provider config, received ${response.providers?.length || 0}`);
  }
  const config = response.providers[0];

  const actualVersion = liveVersionString(config, label);
  if (actualVersion !== providerVersion) {
    drift(`${label}: live provider version is ${actualVersion}, expected ${providerVersion}`);
  }

  // An AI-classified provider would be validated down a different path. Lock In settles real money, so
  // the live configuration must still be the deterministic witness one that was audited.
  if (config.verificationType !== STRAVA_VERIFICATION_TYPE) {
    drift(`${label}: expected verificationType=${STRAVA_VERIFICATION_TYPE}, received ${config.verificationType}`);
  }

  if (config.requestData.length !== expectedHashes.length) {
    drift(`${label}: expected ${expectedHashes.length} required requests, received ${config.requestData.length}`);
  }

  const requestHashes: string[] = [];
  for (const [index, request] of config.requestData.entries()) {
    const value = hashRequestSpec(request).value;
    const hashes = Array.isArray(value) ? value : [value];
    if (hashes.length !== 1) drift(`${label}: request ${index} must resolve to exactly one required hash`);
    if (hashes[0].toLowerCase() !== expectedHashes[index].toLowerCase()) {
      drift(`${label}: provider hash ${index} drifted: expected ${expectedHashes[index]}, received ${hashes[0]}`);
    }
    requestHashes.push(hashes[0]);
  }

  return {
    providerId,
    providerVersion,
    verificationType: config.verificationType,
    requiredRequests: config.requestData.length,
    requestHashes,
  };
}

export function assertLiveStravaProvider(): Promise<LiveProviderCheck> {
  return assertLiveProviderConfig({
    providerId: STRAVA_PROVIDER_ID,
    providerVersion: STRAVA_PROVIDER_VERSION,
    expectedHashes: STRAVA_REQUEST_HASHES,
    label: "strava",
  }).then((check) => {
    if (check.requiredRequests !== STRAVA_PROOF_COUNT) {
      drift(`strava: expected ${STRAVA_PROOF_COUNT} requests, received ${check.requiredRequests}`);
    }
    return check;
  });
}

export function assertLiveDuolingoProvider(): Promise<LiveProviderCheck> {
  return assertLiveProviderConfig({
    providerId: DUOLINGO_PROVIDER_ID,
    providerVersion: DUOLINGO_PROVIDER_VERSION,
    expectedHashes: [DUOLINGO_OWNERSHIP_REQUEST_HASH, DUOLINGO_XP_REQUEST_HASH],
    label: "duolingo",
  });
}

export function assertLiveProviderForMission(mission: "strava" | "duolingo"): Promise<LiveProviderCheck> {
  return mission === "strava" ? assertLiveStravaProvider() : assertLiveDuolingoProvider();
}

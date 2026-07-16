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
} from "../src/strava-proof-policy.js";
import {
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  DUOLINGO_OWNERSHIP_REQUEST_HASH,
  DUOLINGO_XP_REQUEST_HASH,
} from "../src/duolingo-proof-policy.js";

// Drift gate on the LIVE Reclaim provider configuration, run before a release and before a user can
// launch a proof. A proof context carries no providerHash on the Strava provider, so these hashes do not
// pin a proof: the on-chain parser pins the request from claimData.parameters. What this catches is the
// live configuration silently changing under a pinned verifier.

/**
 * The live API returns the version as a structured object on each provider config and does NOT populate
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

function liveVersionString(config: ReclaimProviderConfig, label: string): string {
  const version = (config as unknown as { version?: LiveProviderVersion }).version;
  if (!version || typeof version !== "object") {
    throw new Error(`${label}: live provider config carries no version`);
  }
  const { major, minor, patch, prereleaseTag } = version;
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) {
    throw new Error(`${label}: live provider version is not a semantic version`);
  }
  // A prerelease tag is how Reclaim marks an AI build (`-ai.*`). The audited provider has none.
  if (prereleaseTag !== null && prereleaseTag !== undefined) {
    throw new Error(`${label}: live provider is a prerelease build (-${prereleaseTag}), not the audited version`);
  }
  return `${major}.${minor}.${patch}`;
}

async function exactConfig(providerId: string, providerVersion: string, label: string) {
  const response = await fetchProviderConfigs(providerId, providerVersion, []);
  if (response.providers?.length !== 1) {
    throw new Error(`${label}: expected one exact provider config, received ${response.providers?.length || 0}`);
  }
  const config = response.providers[0];
  const actualVersion = liveVersionString(config, label);
  if (actualVersion !== providerVersion) {
    throw new Error(`${label}: live provider version is ${actualVersion}, expected ${providerVersion}`);
  }
  return config;
}

function assertPinnedHashes(config: ReclaimProviderConfig, expected: readonly string[], label: string): void {
  if (config.requestData.length !== expected.length) {
    throw new Error(`${label}: expected ${expected.length} required requests, received ${config.requestData.length}`);
  }
  for (const [index, request] of config.requestData.entries()) {
    const value = hashRequestSpec(request).value;
    const hashes = Array.isArray(value) ? value : [value];
    if (hashes.length !== 1) {
      throw new Error(`${label}: request ${index} must resolve to exactly one required hash`);
    }
    if (hashes[0].toLowerCase() !== expected[index].toLowerCase()) {
      throw new Error(`${label}: provider hash ${index} drifted: expected ${expected[index]}, received ${hashes[0]}`);
    }
  }
}

const strava = await exactConfig(STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION, "strava");
// An AI-classified provider would be validated down a different path. Lock In settles real money, so the
// live configuration must still be the deterministic witness one that was audited.
if (strava.verificationType !== STRAVA_VERIFICATION_TYPE) {
  throw new Error(`strava: expected verificationType=${STRAVA_VERIFICATION_TYPE}, received ${strava.verificationType}`);
}
if (strava.requestData.length !== STRAVA_PROOF_COUNT) {
  throw new Error(`strava: expected ${STRAVA_PROOF_COUNT} requests, received ${strava.requestData.length}`);
}
assertPinnedHashes(strava, STRAVA_REQUEST_HASHES, "strava");

const duolingo = await exactConfig(DUOLINGO_PROVIDER_ID, DUOLINGO_PROVIDER_VERSION, "duolingo");
if (duolingo.verificationType !== STRAVA_VERIFICATION_TYPE) {
  throw new Error(
    `duolingo: expected verificationType=${STRAVA_VERIFICATION_TYPE}, received ${duolingo.verificationType}`,
  );
}
assertPinnedHashes(duolingo, [DUOLINGO_OWNERSHIP_REQUEST_HASH, DUOLINGO_XP_REQUEST_HASH], "duolingo");

console.log(JSON.stringify({
  strava: {
    providerId: STRAVA_PROVIDER_ID,
    providerVersion: STRAVA_PROVIDER_VERSION,
    verificationType: strava.verificationType,
    requiredRequests: strava.requestData.length,
    schemaPinnedOnchainFrom: "claimData.parameters (this provider emits no providerHash)",
  },
  duolingo: {
    providerId: DUOLINGO_PROVIDER_ID,
    providerVersion: DUOLINGO_PROVIDER_VERSION,
    verificationType: duolingo.verificationType,
    requiredRequests: duolingo.requestData.length,
  },
  hashesMatchPinnedPolicy: true,
}, null, 2));

import {
  fetchProviderConfigs,
  hashRequestSpec,
} from "@reclaimprotocol/js-sdk";
import {
  STRAVA_PROOF_COUNT,
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
} from "../src/strava-proof-policy.js";
import {
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  DUOLINGO_OWNERSHIP_REQUEST_HASH,
  DUOLINGO_XP_REQUEST_HASH,
} from "../src/duolingo-proof-policy.js";

const response = await fetchProviderConfigs(
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
  [],
);
if (response.providers?.length !== 1) {
  throw new Error(`Expected one exact provider config, received ${response.providers?.length || 0}`);
}
const requests = response.providers[0].requestData;
if (requests.length !== STRAVA_PROOF_COUNT) {
  throw new Error(`Expected ${STRAVA_PROOF_COUNT} required requests, received ${requests.length}`);
}

// Strava 6.0.0 signs no context.providerHash, so there is no live hash to pin the way Duolingo does.
// The request schema is pinned on-chain from claimData.parameters (url, method, body, responseMatches,
// responseRedactions, paramValues) by LockInStravaClaimParser, and that pin is exercised against the real
// captured proof set by test/LockInStravaRealProof.t.sol. All this script can add is the claim count.

const duolingoResponse = await fetchProviderConfigs(
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  [],
);
if (duolingoResponse.providers?.length !== 1 || duolingoResponse.providers[0].requestData.length !== 2) {
  throw new Error("Expected one Duolingo provider config with two required requests");
}
const expectedDuolingoHashes = [DUOLINGO_OWNERSHIP_REQUEST_HASH, DUOLINGO_XP_REQUEST_HASH];
for (const [index, request] of duolingoResponse.providers[0].requestData.entries()) {
  const hash = hashRequestSpec(request).value;
  if (!Array.isArray(hash) || hash.length !== 1 || hash[0].toLowerCase() !== expectedDuolingoHashes[index]) {
    throw new Error(`Duolingo provider hash ${index} drifted`);
  }
}

console.log(JSON.stringify({
  providerId: STRAVA_PROVIDER_ID,
  providerVersion: STRAVA_PROVIDER_VERSION,
  requiredRequests: requests.length,
  duolingoProviderId: DUOLINGO_PROVIDER_ID,
  duolingoProviderVersion: DUOLINGO_PROVIDER_VERSION,
  duolingoRequiredRequests: 2,
  stravaSchemaPinnedFrom: "claimData.parameters (no providerHash in 6.0.0)",
  duolingoHashesMatchPinnedPolicy: true,
}, null, 2));

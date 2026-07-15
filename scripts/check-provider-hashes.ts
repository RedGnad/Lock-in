import {
  fetchProviderConfigs,
  hashRequestSpec,
} from "@reclaimprotocol/js-sdk";
import {
  STRAVA_PROVIDER_HASHES,
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
} from "../src/strava-proof-policy.js";
import {
  DUOLINGO_PROVIDER_HASH,
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
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
if (requests.length !== STRAVA_PROVIDER_HASHES.length) {
  throw new Error(`Expected four required requests, received ${requests.length}`);
}

const liveHashes = requests.map((request) => {
  const value = hashRequestSpec(request).value;
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Every Strava request must resolve to exactly one required hash");
  }
  return value[0].toLowerCase();
});

for (const [index, expected] of STRAVA_PROVIDER_HASHES.entries()) {
  if (liveHashes[index] !== expected) {
    throw new Error(`Provider hash ${index} drifted: expected ${expected}, received ${liveHashes[index]}`);
  }
}

const duolingoResponse = await fetchProviderConfigs(
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_PROVIDER_VERSION,
  [],
);
if (duolingoResponse.providers?.length !== 1 || duolingoResponse.providers[0].requestData.length !== 1) {
  throw new Error("Expected one Duolingo provider config with one required request");
}
const duolingoHash = hashRequestSpec(duolingoResponse.providers[0].requestData[0]).value;
if (!Array.isArray(duolingoHash) || duolingoHash.length !== 1 || duolingoHash[0].toLowerCase() !== DUOLINGO_PROVIDER_HASH) {
  throw new Error("Duolingo provider hash drifted");
}

console.log(JSON.stringify({
  providerId: STRAVA_PROVIDER_ID,
  providerVersion: STRAVA_PROVIDER_VERSION,
  requiredRequests: requests.length,
  duolingoProviderId: DUOLINGO_PROVIDER_ID,
  duolingoProviderVersion: DUOLINGO_PROVIDER_VERSION,
  duolingoRequiredRequests: 1,
  hashesMatchPinnedPolicy: true,
}, null, 2));

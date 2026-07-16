import { assertLiveDuolingoProvider, assertLiveStravaProvider } from "../src/reclaim-provider-check.js";

// Pre-flight drift gate on the LIVE Reclaim provider configurations. The release artifact builder runs
// the same assertions, so a release cannot pass against a weaker configuration than this check.

const strava = await assertLiveStravaProvider();
const duolingo = await assertLiveDuolingoProvider();

console.log(JSON.stringify({
  strava: { ...strava, schemaPinnedOnchainFrom: "claimData.parameters (this provider emits no providerHash)" },
  duolingo,
  hashesMatchPinnedPolicy: true,
}, null, 2));

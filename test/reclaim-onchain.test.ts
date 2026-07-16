import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";
import { getIdentifierFromClaimInfo, type Proof } from "@reclaimprotocol/js-sdk";
import {
  reclaimChannelInitOptions,
  reclaimChannelLaunchOptions,
  resolveReclaimChannel,
} from "../src/reclaim-channel.js";
import {
  assertDirectStravaInput,
  assertReclaimSessionProvenance,
  assertSdkProofSet,
  assertDuolingoDirectParity,
  assertPinnedHybridDeployment,
  assertStravaDirectParity,
  DUOLINGO_MAX_SIGNED_JSON_BYTES,
  duolingoCompletionNullifier,
  sessionIdHash,
  PINNED_RECLAIM_WITNESS,
  toDirectProofBundle,
} from "../src/reclaim-onchain.js";

const OWNER = "0x000000000000000000000000000000000000a11c";
const SIGNATURE = `0x${"22".repeat(65)}`;

function proof(overrides: Record<string, unknown> = {}): Proof {
  const parameters = typeof overrides.parameters === "string"
    ? overrides.parameters
    : "{\"headers\":{\"accept\":\"application/json\",\"x-client\":\"lock-in\"},\"method\":\"GET\"}";
  const context = typeof overrides.context === "string"
    ? overrides.context
    : "{\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"reclaimSessionId\":\"session_12345678\"}";
  const claimData = {
    provider: "http",
    parameters,
    context,
    owner: OWNER,
    timestampS: 1_784_000_000,
    epoch: 1,
  };
  const identifier = getIdentifierFromClaimInfo(claimData);
  return {
    identifier,
    claimData: {
      ...claimData,
      identifier,
    },
    signatures: [SIGNATURE],
    witnesses: [{ id: OWNER, url: "https://witness.example" }],
    extractedParameterValues: {},
    teeAttestation: {
      proof_version: "v3",
      tee_provider: "gcp",
      tee_technology: "confidential-space",
      nonce: "nonce",
      timestamp: "2026-07-15T00:00:00Z",
      workload: { container_name: "attestor", image_digest: "sha256:1" },
      verifier: { container_name: "verifier", image_digest: "sha256:2" },
      attestation: { token: "server-verified-only" },
    },
    ...overrides,
  } as Proof;
}

test("requires the concrete SDK proof shape with a signatures array", () => {
  const valid = proof();
  assert.equal(assertSdkProofSet(valid, { expectedCount: 1, maxSignedJsonBytes: DUOLINGO_MAX_SIGNED_JSON_BYTES })[0], valid);
  assert.throws(
    () => assertSdkProofSet({ ...valid, signatures: SIGNATURE }, { expectedCount: 1, maxSignedJsonBytes: DUOLINGO_MAX_SIGNED_JSON_BYTES }),
    /signature in an array/,
  );
  assert.throws(
    () => assertSdkProofSet({ ...valid, teeAttestation: undefined }, { expectedCount: 1, maxSignedJsonBytes: DUOLINGO_MAX_SIGNED_JSON_BYTES }),
    /TEE attestation is missing/,
  );
  assert.doesNotThrow(
    () => assertSdkProofSet({ ...valid, witnesses: [] }, {
      expectedCount: 1,
      maxSignedJsonBytes: DUOLINGO_MAX_SIGNED_JSON_BYTES,
    }),
  );
});

test("rejects claim data that does not match the SDK-canonical identifier", () => {
  const valid = proof();
  const changed = {
    ...valid,
    claimData: { ...valid.claimData, context: valid.claimData.context.replace("session_12345678", "session_attacker") },
  };
  assert.throws(
    () => assertSdkProofSet(changed, { expectedCount: 1, maxSignedJsonBytes: DUOLINGO_MAX_SIGNED_JSON_BYTES }),
    /does not match its identifier/,
  );
});

for (const header of ["cookie", "Authorization", "x-auth-token", "client_secret", "x-api-key"]) {
  test(`rejects sensitive signed header ${header}`, () => {
    const value = proof({ parameters: JSON.stringify({ headers: { [header]: "must-not-be-public" }, method: "GET" }) });
    assert.throws(
      () => assertSdkProofSet(value, { expectedCount: 1, maxSignedJsonBytes: DUOLINGO_MAX_SIGNED_JSON_BYTES }),
      /forbidden sensitive header/,
    );
  });
}

test("keeps parameters byte-exact and canonicalises only the SDK-signed context", () => {
  const parameters = "{\"body\":\"\",\"method\":\"GET\",\"paramValues\":{\"name\":\"LI-ABC\"}}";
  const context = "{\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"reclaimSessionId\":\"session_12345678\",\"extractedParameters\":{\"xp\":\"10\",\"id\":\"7\"},\"contextMessage\":\"0:baseline\"}";
  const value = proof({ parameters, context });
  const checked = assertSdkProofSet(value, { expectedCount: 1, maxSignedJsonBytes: DUOLINGO_MAX_SIGNED_JSON_BYTES });
  const bundle = toDirectProofBundle("session_12345678", checked);
  assert.equal(bundle.proofs[0].claimInfo.parameters, parameters);
  assert.equal(
    bundle.proofs[0].claimInfo.context,
    "{\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"0:baseline\",\"extractedParameters\":{\"id\":\"7\",\"xp\":\"10\"},\"reclaimSessionId\":\"session_12345678\"}",
  );
  assert.deepEqual(bundle.proofs[0].signedClaim.signatures, [SIGNATURE]);
});

test("derives hashes with the exact Solidity encodings", () => {
  assert.equal(sessionIdHash("session_12345678"), keccak256(stringToHex("session_12345678")));
  const identityHash = `0x${"33".repeat(32)}` as const;
  const proofSetHash = `0x${"44".repeat(32)}` as const;
  const expected = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 namespace, bytes32 identityHash, uint64 totalXp, bytes32 proofSetHash"),
    [keccak256(stringToHex("LOCK_IN_DUOLINGO_COMPLETION")), identityHash, 123n, proofSetHash],
  ));
  assert.equal(duolingoCompletionNullifier({ identityHash, totalXp: 123n, proofSetHash }), expected);
});

test("requires exact parity between Duolingo policy and the direct verifier", () => {
  const identityHash = `0x${"33".repeat(32)}` as const;
  const proofSetHash = `0x${"44".repeat(32)}` as const;
  const direct = { identityHash, proofSetHash, totalXp: 123n, proofTimestamp: 1_784_000_000 };
  const policy = { identityHash, totalXp: 123, observedAt: 1_784_000_000 };
  assert.doesNotThrow(() => assertDuolingoDirectParity({ direct, policy, proofSetHash }));
  assert.throws(
    () => assertDuolingoDirectParity({ direct: { ...direct, totalXp: 124n }, policy, proofSetHash }),
    /disagree/,
  );
  assert.throws(
    () => assertDuolingoDirectParity({ direct, policy, proofSetHash: `0x${"55".repeat(32)}` }),
    /disagree/,
  );
});

test("requires exact parity for every Strava field signed by the backend", () => {
  const identityHash = `0x${"33".repeat(32)}` as const;
  const nullifier = `0x${"44".repeat(32)}` as const;
  const proofSetHash = `0x${"55".repeat(32)}` as const;
  const timestamps = [1_784_000_000, 1_784_000_001];
  const direct = {
    identityHash,
    nullifier,
    proofSetHash,
    distanceMeters: 5_000n,
    startTime: 1_784_000_000n,
    movingTimeSeconds: 1_500n,
    elapsedTimeSeconds: 1_800n,
    elevationGainMeters: 50n,
    oldestProofTimestamp: timestamps[0],
    newestProofTimestamp: timestamps[1],
  };
  const policy = {
    identityHash,
    nullifier,
    distanceMeters: 5_000,
    startTimeMs: 1_784_000_000_000,
    movingTimeSeconds: 1_500,
    elapsedTimeSeconds: 1_800,
    elevationGainMeters: 50,
  };
  assert.doesNotThrow(() => assertStravaDirectParity({ direct, policy, proofSetHash, timestamps }));
  for (const changed of [
    { ...direct, distanceMeters: 4_999n },
    { ...direct, movingTimeSeconds: 1_499n },
    { ...direct, elapsedTimeSeconds: 1_799n },
    { ...direct, elevationGainMeters: 49n },
    { ...direct, newestProofTimestamp: timestamps[1] + 1 },
  ]) {
    assert.throws(() => assertStravaDirectParity({ direct: changed, policy, proofSetHash, timestamps }), /disagree/);
  }
});

test("pins both verifier addresses and the audited Reclaim witness", () => {
  const strava = "0x0000000000000000000000000000000000001001" as const;
  const duolingo = "0x0000000000000000000000000000000000002002" as const;
  const valid = {
    observedStravaVerifier: strava,
    configuredStravaVerifier: strava,
    observedDuolingoVerifier: duolingo,
    configuredDuolingoVerifier: duolingo,
    stravaWitness: PINNED_RECLAIM_WITNESS,
    duolingoWitness: PINNED_RECLAIM_WITNESS,
    configuredWitness: PINNED_RECLAIM_WITNESS,
  };
  assert.doesNotThrow(() => assertPinnedHybridDeployment(valid));
  assert.throws(
    () => assertPinnedHybridDeployment({ ...valid, observedStravaVerifier: duolingo }),
    /verifier address mismatch/,
  );
  assert.throws(
    () => assertPinnedHybridDeployment({
      ...valid,
      duolingoWitness: "0x0000000000000000000000000000000000003003",
    }),
    /witness mismatch/,
  );
});

const STRAVA_SESSION = {
  sessionId: "fa8968844e",
  appId: "0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf",
  providerId: "f3ec8292-d8f3-487c-a79d-f53f482f88e2",
  providerVersionString: "6.0.0",
  statusV2: "PROOF_SUBMITTED",
  proofs: [{}, {}],
};

const STRAVA_EXPECTED = {
  sessionId: "fa8968844e",
  appId: "0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf",
  providerId: "f3ec8292-d8f3-487c-a79d-f53f482f88e2",
  providerVersion: "6.0.0",
};

test("accepts a Strava session executed by the exact pinned provider and submitted deterministically", () => {
  assert.doesNotThrow(() =>
    assertReclaimSessionProvenance({ session: STRAVA_SESSION, expected: STRAVA_EXPECTED }));
  // App id casing is cosmetic; the identity is not.
  assert.doesNotThrow(() => assertReclaimSessionProvenance({
    session: { ...STRAVA_SESSION, appId: STRAVA_SESSION.appId.toLowerCase() },
    expected: STRAVA_EXPECTED,
  }));
});

test("rejects a Reclaim session whose provenance does not match the initiated one", () => {
  const cases: Array<[Record<string, unknown> | undefined, RegExp]> = [
    [undefined, /incomplete/],
    [{ ...STRAVA_SESSION, sessionId: "other" }, /session mismatch/],
    [{ ...STRAVA_SESSION, appId: "0x0000000000000000000000000000000000000bad" }, /application mismatch/],
    [{ ...STRAVA_SESSION, providerId: "cdf8cb3b-2976-4413-ab2d-693ae5028380" }, /provider mismatch/],
    // A -ai prerelease or any other build is not the audited deterministic provider.
    [{ ...STRAVA_SESSION, providerVersionString: "6.0.0-ai.1" }, /provider version mismatch/],
    [{ ...STRAVA_SESSION, providerVersionString: "5.0.0" }, /provider version mismatch/],
    // The AI submission path must be refused explicitly, as must any unknown terminal state.
    [{ ...STRAVA_SESSION, statusV2: "AI_PROOF_SUBMITTED" }, /Unexpected Reclaim submission state/],
    [{ ...STRAVA_SESSION, statusV2: "ERROR_SUBMISSION_FAILED" }, /Unexpected Reclaim submission state/],
    [{ ...STRAVA_SESSION, statusV2: undefined }, /Unexpected Reclaim submission state/],
    [{ ...STRAVA_SESSION, proofs: undefined }, /proof set is absent/],
  ];
  for (const [session, expected] of cases) {
    assert.throws(
      () => assertReclaimSessionProvenance({ session: session as never, expected: STRAVA_EXPECTED }),
      expected,
    );
  }
});

test("refuses to verify when the application id is not configured", () => {
  assert.throws(
    () => assertReclaimSessionProvenance({
      session: STRAVA_SESSION,
      expected: { ...STRAVA_EXPECTED, appId: "" },
    }),
    /application id is not configured/,
  );
});

test("guards the direct Strava verifier call with the live provider proof count", () => {
  // Regression: the route required 4 proofs after the provider was redesigned to 2, so every valid
  // 6.0.0 proof was refused before reaching Solidity. The route now calls this exact helper.
  assert.doesNotThrow(() => assertDirectStravaInput({ hasEscrow: true, proofCount: 2, dayIndex: 0 }));
  assert.doesNotThrow(() => assertDirectStravaInput({ hasEscrow: true, proofCount: 2, dayIndex: 29 }));

  assert.throws(
    () => assertDirectStravaInput({ hasEscrow: true, proofCount: 4, dayIndex: 0 }),
    /exactly 2 proofs, received 4/,
  );
  assert.throws(
    () => assertDirectStravaInput({ hasEscrow: true, proofCount: 1, dayIndex: 0 }),
    /exactly 2 proofs, received 1/,
  );
  assert.throws(
    () => assertDirectStravaInput({ hasEscrow: false, proofCount: 2, dayIndex: 0 }),
    /escrow address is not configured/,
  );
  assert.throws(
    () => assertDirectStravaInput({ hasEscrow: true, proofCount: 2, dayIndex: undefined }),
    /bound to a day index/,
  );
});

test("resolves the Reclaim delivery channel from configuration, failing closed", () => {
  // The channel decides whether a user re-authenticates inside a remote browser on every check-in, so a
  // typo must not silently fall back to the remote one.
  assert.equal(resolveReclaimChannel(undefined), "portal");
  assert.equal(resolveReclaimChannel(""), "portal");
  assert.equal(resolveReclaimChannel("portal"), "portal");
  assert.equal(resolveReclaimChannel("app"), "app");
  assert.equal(resolveReclaimChannel(" APP "), "app");
  assert.throws(() => resolveReclaimChannel("mobile"), /must be "portal" or "app"/);
  assert.throws(() => resolveReclaimChannel("extension"), /must be "portal" or "app"/);
});

test("app mode asks for the App Clip and the deferred deep link, each in the options the SDK reads", () => {
  // useAppClip is a ProofRequestOptions field; canUseDeferredDeepLinksFlow is a launch option. Putting the
  // deep link in the init options would have been silently ignored.
  assert.deepEqual(reclaimChannelInitOptions("app"), { useAppClip: true });
  assert.deepEqual(reclaimChannelInitOptions("portal"), {});
  assert.deepEqual(reclaimChannelLaunchOptions("app"), { verificationMode: "app", canUseDeferredDeepLinksFlow: true });
  assert.deepEqual(reclaimChannelLaunchOptions("portal"), { verificationMode: "portal" });
});

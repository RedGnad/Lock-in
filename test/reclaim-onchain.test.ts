import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";
import { getIdentifierFromClaimInfo, type Proof } from "@reclaimprotocol/js-sdk";
import {
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

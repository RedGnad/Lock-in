import assert from "node:assert/strict";
import test from "node:test";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  attestationExpiry,
  completionTypes,
  signCompletion,
} from "../src/completion-attestation.js";

const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const ESCROW = "0x1111111111111111111111111111111111111111";
const domain = { name: "Lock In", version: "1", chainId: 143, verifyingContract: ESCROW } as const;

test("attestation expiry never outlives either the signer window or the oldest observation", () => {
  assert.equal(attestationExpiry(1_000n, [950, 960]), 1_300n);
  assert.equal(attestationExpiry(1_000n, [650, 990]), 1_250n);
  assert.throws(() => attestationExpiry(1_000n, [400]), /expired before it could be attested/);
  assert.throws(() => attestationExpiry(1_000n, []), /valid observation timestamp/);
});

test("completion signature binds day, mission, metric, occurrence, issue time, and contract", async () => {
  const completion = {
    pactId: 7n,
    account: ACCOUNT.address,
    dayIndex: 2,
    missionType: 1,
    policyHash: `0x${"66".repeat(32)}` as const,
    sessionIdHash: `0x${"77".repeat(32)}` as const,
    identityHash: `0x${"33".repeat(32)}` as const,
    eventNullifier: `0x${"44".repeat(32)}` as const,
    metric: 5_000n,
    proofSetHash: `0x${"55".repeat(32)}` as const,
    occurredAt: 1_800_100_000n,
    oldestProofTimestamp: 1_800_100_090,
    newestProofTimestamp: 1_800_100_100,
    movingTimeSeconds: 1_500n,
    elapsedTimeSeconds: 1_800n,
    elevationGainMeters: 50n,
    issuedAt: 1_800_100_100n,
    expiresAt: 1_800_100_400n,
  };
  const signature = await signCompletion({ privateKey: PRIVATE_KEY, chainId: 143, verifyingContract: ESCROW, completion });
  assert.equal(await recoverTypedDataAddress({
    domain,
    types: completionTypes,
    primaryType: "Completion",
    message: completion,
    signature,
  }), ACCOUNT.address);
  assert.notEqual(await recoverTypedDataAddress({
    domain: { ...domain, verifyingContract: "0x2222222222222222222222222222222222222222" },
    types: completionTypes,
    primaryType: "Completion",
    message: completion,
    signature,
  }), ACCOUNT.address);
  assert.notEqual(await recoverTypedDataAddress({
    domain,
    types: completionTypes,
    primaryType: "Completion",
    message: { ...completion, movingTimeSeconds: completion.movingTimeSeconds + 1n },
    signature,
  }), ACCOUNT.address);
});

import assert from "node:assert/strict";
import test from "node:test";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACCESS_CREATE,
  accessDomain,
  accessTypes,
  signAccess,
  type AccessAttestation,
} from "../src/access-attestation.js";
import {
  DUOLINGO_MISSION_POLICY_ID,
  STRAVA_MISSION_POLICY_ID,
  hashPactConfiguration,
  missionPolicyIdForType,
} from "../src/pact-configuration.js";

const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const ESCROW = "0x1111111111111111111111111111111111111111";

const configuration = {
  stake: 500_000n,
  dailyTarget: 3_000,
  durationDays: 7,
  requiredCompletions: 5,
  minParticipants: 2,
  maxParticipants: 4,
  startsAt: 1_800_007_200n,
  missionType: 1,
} as const;

test("mission policy identifiers are stable and mission-specific", () => {
  assert.equal(missionPolicyIdForType(1), STRAVA_MISSION_POLICY_ID);
  assert.equal(missionPolicyIdForType(2), DUOLINGO_MISSION_POLICY_ID);
  assert.notEqual(STRAVA_MISSION_POLICY_ID, DUOLINGO_MISSION_POLICY_ID);
  assert.throws(() => missionPolicyIdForType(3), /Unsupported mission/);
});

test("pact configuration hash binds every user-controlled field", () => {
  const expected = hashPactConfiguration(configuration);
  const mutations = [
    { ...configuration, stake: 1_000_000n },
    { ...configuration, dailyTarget: 5_000 },
    { ...configuration, durationDays: 14 },
    { ...configuration, requiredCompletions: 4 },
    { ...configuration, minParticipants: 3 },
    { ...configuration, maxParticipants: 8 },
    { ...configuration, startsAt: configuration.startsAt + 1n },
    { ...configuration, missionType: 2 },
  ];
  for (const mutation of mutations) assert.notEqual(hashPactConfiguration(mutation), expected);
});

test("access signature binds account, action, pact, configuration, issue time, and expiry", async () => {
  const access: AccessAttestation = {
    account: ACCOUNT.address,
    action: ACCESS_CREATE,
    pactId: 0n,
    configHash: hashPactConfiguration(configuration),
    nonce: `0x${"12".repeat(32)}`,
    issuedAt: 1_800_000_000n,
    expiresAt: 1_800_000_300n,
  };
  const signature = await signAccess({
    privateKey: PRIVATE_KEY,
    chainId: 143,
    verifyingContract: ESCROW,
    access,
  });
  assert.equal(await recoverTypedDataAddress({
    domain: accessDomain(143, ESCROW),
    types: accessTypes,
    primaryType: "Access",
    message: access,
    signature,
  }), ACCOUNT.address);

  assert.notEqual(await recoverTypedDataAddress({
    domain: accessDomain(143, ESCROW),
    types: accessTypes,
    primaryType: "Access",
    message: { ...access, pactId: 1n },
    signature,
  }), ACCOUNT.address);
});

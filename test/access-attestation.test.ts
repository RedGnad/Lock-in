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

test("the mission policy identifier is the one the DEPLOYED escrow returns", () => {
  // Regression, and the reason createPact was impossible: this derivation used to be
  // keccak256("LOCK_IN_POLICY_STRAVA_RUN"), a zkTLS-era constant that the escrow never knew about, so the
  // admission attestation was bound to a config hash the contract could not reproduce and every creation
  // reverted. The tests on both sides passed, because each checked its own derivation against itself and
  // nothing checked TypeScript against Solidity.
  //
  // This is the value `missionPolicyHash(1)` returns on escrow 0xD37121112F240fE03a18D754B2fdB9dC750034d4,
  // Monad chain 143, and /api/health publishes it. If this test fails, either the escrow was redeployed or
  // the derivation drifted again: check the chain before touching the expectation.
  assert.equal(
    missionPolicyIdForType(1),
    "0x99a84a67b7245bd9592d49a5c750096fb5990b373834c02cc0913c99161302bf",
  );
  assert.equal(missionPolicyIdForType(1), STRAVA_MISSION_POLICY_ID);
  // Strava is the only mission: anything else must be refused rather than silently defaulted.
  for (const unknown of [0, 2, 3, 255]) {
    assert.throws(() => missionPolicyIdForType(unknown), /Unsupported mission/);
  }
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
  ];
  for (const mutation of mutations) assert.notEqual(hashPactConfiguration(mutation), expected);
  // missionType is bound too, but there is only one mission now: an unknown one cannot be hashed at all,
  // so it can never reach an access pass.
  assert.throws(() => hashPactConfiguration({ ...configuration, missionType: 2 }), /Unsupported mission/);
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

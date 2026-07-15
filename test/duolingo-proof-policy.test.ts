import assert from "node:assert/strict";
import test from "node:test";
import {
  DUOLINGO_PROVIDER_ID,
  duolingoOwnershipCode,
  validateDuolingoEvidence,
} from "../src/duolingo-proof-policy";

const wallet = "0x000000000000000000000000000000000000a11c";
const code = duolingoOwnershipCode(wallet);
const context = {
  contextAddress: wallet,
  contextMessage: "42:baseline",
  reclaimSessionId: "session-123",
};

function trusted(overrides: Record<string, string> = {}) {
  return [{
    context,
    extractedParameters: {
      id: "123456",
      username: "alice.test",
      name: code,
      totalXp: "1000",
      ...overrides,
    },
  }];
}

test("accepts an ownership-bound Duolingo XP snapshot", () => {
  assert.match(code, /^LOCK-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
  const result = validateDuolingoEvidence({
    data: trusted(),
    timestamps: [1_784_000_000],
    providerId: DUOLINGO_PROVIDER_ID,
    policy: {
      walletAddress: wallet,
      pactId: "42",
      phase: "baseline",
      expectedSessionId: "session-123",
      expectedOwnershipCode: code,
    },
  });
  assert.equal(result.totalXp, 1000);
  assert.equal(result.profileId, "123456");
  assert.match(result.identityHash, /^0x[0-9a-f]{64}$/);
});

test("rejects targeting somebody else's public profile", () => {
  assert.throws(() => validateDuolingoEvidence({
    data: trusted({ name: "somebody else's name" }),
    timestamps: [1_784_000_000],
    providerId: DUOLINGO_PROVIDER_ID,
    policy: {
      walletAddress: wallet,
      pactId: "42",
      phase: "baseline",
      expectedSessionId: "session-123",
      expectedOwnershipCode: code,
    },
  }), /Set the Duolingo Name/);
});

test("binds the proof to the wallet, pact, phase and Reclaim session", () => {
  for (const changed of [
    { ...context, contextAddress: "0x000000000000000000000000000000000000b0b0" },
    { ...context, contextMessage: "43:baseline" },
    { ...context, reclaimSessionId: "session-attacker" },
  ]) {
    assert.throws(() => validateDuolingoEvidence({
      data: [{ ...trusted()[0], context: changed }],
      timestamps: [1_784_000_000],
      providerId: DUOLINGO_PROVIDER_ID,
      policy: {
        walletAddress: wallet,
        pactId: "42",
        phase: "baseline",
        expectedSessionId: "session-123",
        expectedOwnershipCode: code,
      },
    }));
  }
});

test("same profile and XP produce a stable global snapshot nullifier", () => {
  const policy = {
    walletAddress: wallet,
    pactId: "42",
    phase: "baseline" as const,
    expectedSessionId: "session-123",
    expectedOwnershipCode: code,
  };
  const first = validateDuolingoEvidence({ data: trusted(), timestamps: [1], providerId: DUOLINGO_PROVIDER_ID, policy });
  const second = validateDuolingoEvidence({ data: trusted(), timestamps: [2], providerId: DUOLINGO_PROVIDER_ID, policy });
  assert.equal(first.eventNullifier, second.eventNullifier);
});

test("rejects any provider id other than the pinned Duolingo provider", () => {
  assert.throws(() => validateDuolingoEvidence({
    data: trusted(),
    timestamps: [1_784_000_000],
    providerId: "00000000-0000-4000-8000-000000000001",
    policy: {
      walletAddress: wallet,
      pactId: "42",
      phase: "baseline",
      expectedSessionId: "session-123",
      expectedOwnershipCode: code,
    },
  }), /pinned Duolingo provider/);
});

test("uses the same canonical numeric and exact display-name grammar as the onchain verifier", () => {
  const invalidFields: Record<string, string>[] = [
    { id: "0123456" },
    { id: "18446744073709551616" },
    { totalXp: "01000" },
    { name: ` ${code}` },
    { name: `${code} ` },
  ];
  for (const fields of invalidFields) {
    assert.throws(() => validateDuolingoEvidence({
      data: trusted(fields),
      timestamps: [1_784_000_000],
      providerId: DUOLINGO_PROVIDER_ID,
      policy: {
        walletAddress: wallet,
        pactId: "42",
        phase: "baseline",
        expectedSessionId: "session-123",
        expectedOwnershipCode: code,
      },
    }));
  }
});

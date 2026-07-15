import assert from "node:assert/strict";
import test from "node:test";
import {
  DUOLINGO_OWNERSHIP_REQUEST_HASH,
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_XP_REQUEST_HASH,
  validateDuolingoEvidence,
} from "../src/duolingo-proof-policy";
import type { ReclaimTrustedData } from "../src/strava-proof-policy";

const wallet = "0x000000000000000000000000000000000000a11c";
const baseContext = {
  contextAddress: wallet,
  contextMessage: "42:baseline",
  reclaimSessionId: "session-123",
};

function trusted(input: {
  marker?: string;
  id?: string;
  username?: string;
  xp?: string;
  ownershipContext?: Record<string, unknown>;
  xpContext?: Record<string, unknown>;
} = {}): ReclaimTrustedData[] {
  return [
    {
      context: { ...baseContext, providerHash: DUOLINGO_OWNERSHIP_REQUEST_HASH, ...input.ownershipContext },
      extractedParameters: { marker: input.marker ?? "disable_social" },
    },
    {
      context: { ...baseContext, providerHash: DUOLINGO_XP_REQUEST_HASH, ...input.xpContext },
      extractedParameters: {
        id: input.id ?? "123456",
        username: input.username ?? "alice.test",
        xp: input.xp ?? "1000",
      },
    },
  ];
}

const policy = {
  walletAddress: wallet,
  pactId: "42",
  phase: "baseline" as const,
  expectedSessionId: "session-123",
  expectedProfileId: "123456",
};

test("accepts separate self-ownership and XP proofs without changing a display name", () => {
  const result = validateDuolingoEvidence({
    data: trusted(),
    timestamps: [1_784_000_000, 1_784_000_003],
    providerId: DUOLINGO_PROVIDER_ID,
    policy,
  });
  assert.equal(result.totalXp, 1000);
  assert.equal(result.profileId, "123456");
  assert.equal(result.observedAt, 1_784_000_003);
  assert.match(result.identityHash, /^0x[0-9a-f]{64}$/);
});

test("rejects a missing self-only ownership marker", () => {
  assert.throws(() => validateDuolingoEvidence({
    data: trusted({ marker: "disable_leaderboards" }),
    timestamps: [1, 2],
    providerId: DUOLINGO_PROVIDER_ID,
    policy,
  }), /does not control/);
});

test("rejects a profile response that differs from the server-resolved username id", () => {
  assert.throws(() => validateDuolingoEvidence({
    data: trusted({ id: "654321" }),
    timestamps: [1, 2],
    providerId: DUOLINGO_PROVIDER_ID,
    policy,
  }), /does not match/);
});

test("binds both proofs to wallet, lock phase, session and exact request schemas", () => {
  for (const changed of [
    { ownershipContext: { contextAddress: "0x000000000000000000000000000000000000b0b0" } },
    { xpContext: { contextMessage: "43:baseline" } },
    { ownershipContext: { reclaimSessionId: "session-attacker" } },
    { xpContext: { providerHash: DUOLINGO_OWNERSHIP_REQUEST_HASH } },
  ]) {
    assert.throws(() => validateDuolingoEvidence({
      data: trusted(changed),
      timestamps: [1, 2],
      providerId: DUOLINGO_PROVIDER_ID,
      policy,
    }));
  }
});

test("same profile and XP produce a stable global snapshot nullifier", () => {
  const first = validateDuolingoEvidence({ data: trusted(), timestamps: [1, 2], providerId: DUOLINGO_PROVIDER_ID, policy });
  const second = validateDuolingoEvidence({ data: trusted(), timestamps: [3, 4], providerId: DUOLINGO_PROVIDER_ID, policy });
  assert.equal(first.eventNullifier, second.eventNullifier);
});

test("rejects wrong counts, providers and non-canonical numeric fields", () => {
  assert.throws(() => validateDuolingoEvidence({ data: trusted().slice(1), timestamps: [1], providerId: DUOLINGO_PROVIDER_ID, policy }));
  assert.throws(() => validateDuolingoEvidence({ data: trusted(), timestamps: [1, 2], providerId: "wrong-provider", policy }));
  for (const fields of [{ id: "0123456" }, { id: "18446744073709551616" }, { xp: "01000" }]) {
    assert.throws(() => validateDuolingoEvidence({
      data: trusted(fields),
      timestamps: [1, 2],
      providerId: DUOLINGO_PROVIDER_ID,
      policy,
    }));
  }
});

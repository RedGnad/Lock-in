import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, stringToHex } from "viem";
import {
  DUOLINGO_OWNERSHIP_REQUEST_HASH,
  DUOLINGO_PROVIDER_ID,
  DUOLINGO_XP_REQUEST_HASH,
  DuolingoPolicyError,
  validateDuolingoDelta,
  validateDuolingoEvidence,
  type DuolingoEvidence,
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

test("accepts separate self-ownership and XP proofs without publishing a display name", () => {
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

// --- DUOLINGO_ZKTLS_DELTA_V1 -------------------------------------------------------------------------
// Two proofs per Lock, baseline then final. Everything below lives in the RELATION between them, which is
// exactly where a per-proof check cannot help: each proof can be perfectly valid on its own while the pair
// is a lie.

function evidence(overrides: Partial<DuolingoEvidence> = {}): DuolingoEvidence {
  return {
    profileId: "477033640",
    totalXp: 8_193,
    identityHash: keccak256(stringToHex("identity:477033640")),
    eventNullifier: keccak256(stringToHex("nullifier:baseline")),
    observedAt: 1_784_253_360,
    sessionId: "a27c3d87fe",
    phase: "baseline",
    ...overrides,
  };
}

function finalEvidence(overrides: Partial<DuolingoEvidence> = {}): DuolingoEvidence {
  return evidence({
    totalXp: 8_207,
    eventNullifier: keccak256(stringToHex("nullifier:final")),
    observedAt: 1_784_255_388,
    phase: "final",
    ...overrides,
  });
}

test("the real captured cycle passes: 8193 -> 8207 earns 14 XP", () => {
  const delta = validateDuolingoDelta({ baseline: evidence(), final: finalEvidence(), targetXp: 10 });
  assert.equal(delta.earnedXp, 14);
  assert.equal(delta.baselineXp, 8_193);
  assert.equal(delta.finalXp, 8_207);
});

test("missing the target is refused, and says by how much", () => {
  assert.throws(
    () => validateDuolingoDelta({ baseline: evidence(), final: finalEvidence(), targetXp: 300 }),
    (e: unknown) => e instanceof DuolingoPolicyError && e.code === "TARGET_NOT_MET"
      && /Earned 14 XP of the 300/.test(e.message),
  );
});

test("the athlete cannot swap Duolingo accounts between the two proofs", () => {
  // Otherwise anyone could baseline on a fresh account and finalise on a friend's 100k-XP profile.
  assert.throws(
    () => validateDuolingoDelta({
      baseline: evidence(),
      final: finalEvidence({ identityHash: keccak256(stringToHex("identity:999")) }),
      targetXp: 10,
    }),
    (e: unknown) => e instanceof DuolingoPolicyError && e.code === "IDENTITY_CHANGED",
  );
});

test("a proof cannot play both ends of its own delta", () => {
  const same = evidence();
  for (const [pair, code] of [
    [{ baseline: same, final: { ...same, phase: "final" as const } }, "REPLAYED_PROOF"],
    [{ baseline: same, final: finalEvidence({ observedAt: same.observedAt }) }, "FINAL_NOT_AFTER_BASELINE"],
    [{ baseline: finalEvidence(), final: finalEvidence() }, "WRONG_PHASE_ORDER"],
  ] as const) {
    assert.throws(
      () => validateDuolingoDelta({ ...pair, targetXp: 1 }),
      (e: unknown) => e instanceof DuolingoPolicyError && e.code === code,
      `expected ${code}`,
    );
  }
});

test("XP going backwards is refused rather than read as a negative delta", () => {
  assert.throws(
    () => validateDuolingoDelta({ baseline: evidence({ totalXp: 9_000 }), final: finalEvidence({ totalXp: 8_207 }), targetXp: 1 }),
    (e: unknown) => e instanceof DuolingoPolicyError && e.code === "XP_WENT_BACKWARDS",
  );
});

test("the final proof must be fresh, and cannot be dated in the future", () => {
  const now = 1_784_255_388 + 600;
  assert.ok(validateDuolingoDelta({
    baseline: evidence(), final: finalEvidence(), targetXp: 10, maxFinalAgeSeconds: 3_600, now,
  }));
  assert.throws(
    () => validateDuolingoDelta({
      baseline: evidence(), final: finalEvidence(), targetXp: 10, maxFinalAgeSeconds: 60, now,
    }),
    (e: unknown) => e instanceof DuolingoPolicyError && e.code === "FINAL_TOO_OLD",
  );
  assert.throws(
    () => validateDuolingoDelta({
      baseline: evidence(), final: finalEvidence({ observedAt: now + 3_600 }), targetXp: 10,
      maxFinalAgeSeconds: 3_600, now,
    }),
    (e: unknown) => e instanceof DuolingoPolicyError && e.code === "FINAL_IN_FUTURE",
  );
});

test("a zero or negative target is a misconfiguration, not a free win", () => {
  for (const targetXp of [0, -1, 1.5]) {
    assert.throws(
      () => validateDuolingoDelta({ baseline: evidence(), final: finalEvidence(), targetXp }),
      (e: unknown) => e instanceof DuolingoPolicyError && e.code === "INVALID_TARGET",
    );
  }
});

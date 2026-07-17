// The financial escrow's attestation core: on-chain identity, phase nullifiers, and the EIP-712 baseline
// and final signatures the contract accepts. The signer key and HMAC key mirror the parity pin so the
// recovered address is the deployed evidence signer.

process.env.DUOLINGO_IDENTITY_HMAC_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.DUOLINGO_ESCROW_ADDRESS = "0xD37121112F240fE03a18D754B2fdB9dC750034d4";

import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import {
  BASELINE_TYPES,
  DUOLINGO_DOMAIN,
  FINAL_TYPES,
  duolingoEvidenceSignerAddress,
  duolingoIdentityHash,
} from "../src/duolingo-attestation.js";
import {
  ESCROW_ATTESTATION_TTL_SECONDS,
  buildBaselineAttestation,
  buildFinalAttestation,
  escrowAttestationWindow,
  escrowBaselineNullifier,
  escrowContextMessage,
  escrowFinalNullifier,
  escrowVerifyingContract,
} from "../src/duolingo-escrow-attestation.js";

const CONTRACT = "0xD37121112F240fE03a18D754B2fdB9dC750034d4" as const;
const NONCE_A = `0x${"a1".repeat(32)}` as Hex;
const NONCE_B = `0x${"b2".repeat(32)}` as Hex;
const CONFIG = `0x${"cc".repeat(32)}` as Hex;
const PROFILE = "477033640";
const ACCOUNT = "0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45" as Hex;
const identity = duolingoIdentityHash(PROFILE);

test("the verifying contract is the pinned escrow, and an unset address is refused", () => {
  assert.equal(escrowVerifyingContract(), getAddress(CONTRACT));
  assert.throws(() => escrowVerifyingContract({}), /not configured/);
  assert.throws(() => escrowVerifyingContract({ DUOLINGO_ESCROW_ADDRESS: "nope" }), /not configured/);
});

test("context messages are phase and lock scoped", () => {
  assert.equal(escrowContextMessage({ intent: "create", createNonce: NONCE_A }), `escrow:create:${NONCE_A}:baseline`);
  assert.equal(escrowContextMessage({ intent: "join", pactId: 7n }), "escrow:join:7:baseline");
  assert.equal(escrowContextMessage({ intent: "final", pactId: 7n }), "escrow:final:7:final");
  assert.throws(() => escrowContextMessage({ intent: "join", pactId: 0n }), /Invalid pact/);
  assert.throws(() => escrowContextMessage({ intent: "create", createNonce: "0x12" as Hex }), /Invalid create nonce/);
});

test("nullifiers are deterministic, and distinct across phase, nonce, lock and identity", () => {
  const createA = escrowBaselineNullifier({ identityHash: identity, intent: "create", createNonce: NONCE_A });
  const createArepeat = escrowBaselineNullifier({ identityHash: identity, intent: "create", createNonce: NONCE_A });
  const createB = escrowBaselineNullifier({ identityHash: identity, intent: "create", createNonce: NONCE_B });
  const join1 = escrowBaselineNullifier({ identityHash: identity, intent: "join", pactId: 1n });
  const join2 = escrowBaselineNullifier({ identityHash: identity, intent: "join", pactId: 2n });
  const final1 = escrowFinalNullifier({ identityHash: identity, pactId: 1n });
  const otherIdentity = escrowFinalNullifier({ identityHash: duolingoIdentityHash("1"), pactId: 1n });

  assert.equal(createA, createArepeat); // deterministic: safe resubmission after a reverted tx
  const all = [createA, createB, join1, join2, final1, otherIdentity];
  assert.equal(new Set(all).size, all.length, "every nullifier must be distinct");
  for (const n of all) assert.match(n, /^0x[0-9a-f]{64}$/);
});

test("the attestation window sits inside the contract's MAX_ATTESTATION_AGE", () => {
  const now = 1_800_000_000;
  const { issuedAt, expiresAt } = escrowAttestationWindow(now);
  assert.equal(issuedAt, BigInt(now));
  assert.equal(expiresAt, BigInt(now + ESCROW_ATTESTATION_TTL_SECONDS));
  assert.ok(expiresAt - issuedAt <= 10n * 60n, "expiry must be within 10 minutes");
});

test("a create baseline attestation recovers to the evidence signer and carries the HMAC identity", async () => {
  const now = 1_800_000_000;
  const a = await buildBaselineAttestation({
    account: ACCOUNT, profileId: PROFILE, configHash: CONFIG, intent: "create", createNonce: NONCE_A, now,
  });
  assert.equal(a.identityHash, identity); // HMAC pseudonym, never the raw id
  assert.equal(a.nullifier, escrowBaselineNullifier({ identityHash: identity, intent: "create", createNonce: NONCE_A }));
  const recovered = await recoverTypedDataAddress({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract: CONTRACT },
    types: BASELINE_TYPES,
    primaryType: "Baseline",
    message: { account: ACCOUNT, configHash: CONFIG, identityHash: a.identityHash, nullifier: a.nullifier, issuedAt: a.issuedAt, expiresAt: a.expiresAt },
    signature: a.signature,
  });
  assert.equal(recovered, duolingoEvidenceSignerAddress());
});

test("a final attestation recovers to the signer, and a tampered earnedXp does not", async () => {
  const now = 1_800_000_000;
  const a = await buildFinalAttestation({
    account: ACCOUNT, profileId: PROFILE, pactId: 7n, earnedXp: 60, targetXp: 50, occurredAt: now - 100, now,
  });
  assert.equal(a.nullifier, escrowFinalNullifier({ identityHash: identity, pactId: 7n }));
  const message = {
    pactId: 7n, account: ACCOUNT, identityHash: a.identityHash, earnedXp: a.earnedXp, targetXp: a.targetXp,
    nullifier: a.nullifier, occurredAt: a.occurredAt, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
  };
  const good = await recoverTypedDataAddress({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract: CONTRACT }, types: FINAL_TYPES, primaryType: "Final", message, signature: a.signature,
  });
  assert.equal(good, duolingoEvidenceSignerAddress());
  const tampered = await recoverTypedDataAddress({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract: CONTRACT }, types: FINAL_TYPES, primaryType: "Final",
    message: { ...message, earnedXp: 999 }, signature: a.signature,
  });
  assert.notEqual(tampered, duolingoEvidenceSignerAddress());
});

test("without a configured escrow address, nothing can be signed", async () => {
  await assert.rejects(
    buildBaselineAttestation(
      { account: ACCOUNT, profileId: PROFILE, configHash: CONFIG, intent: "create", createNonce: NONCE_A },
      {},
    ),
    /not configured/,
  );
});

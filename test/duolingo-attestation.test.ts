// The TypeScript half of the EIP-712 parity pin. Every value here is asserted identical in
// test/DuolingoParity.t.sol against the deployed contract. If either formula drifts, one side fails.
// This is the guard the Strava config-hash bug lacked, where each side validated only its own formula.

process.env.DUOLINGO_IDENTITY_HMAC_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, recoverTypedDataAddress, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASELINE_TYPES,
  DUOLINGO_DOMAIN,
  DUOLINGO_XP_SCHEME,
  FINAL_TYPES,
  duolingoEvidenceSignerAddress,
  duolingoIdentityHash,
  hashDuolingoConfiguration,
  missionPolicyHash,
  signBaseline,
  signFinal,
} from "../src/duolingo-attestation.js";

// The exact hex the contract produces (see DuolingoParity.t.sol).
const PIN_SCHEME = "0xd62e6c7e75cd26ab2580957b7b625c3001b336738da6de4d1065b51885d00a6a";
const PIN_POLICY = "0xf0d329a0efb712f1b2a10ba741f1e5b798a1af0a2df26b841e6189f7f2d96031";
const PIN_NONCE = "0x02996131f59c2ed6027ae65cb865a53a83bafa76c7c153a62659c29633b9eeb3";
const PIN_CONFIG = "0xd39ff3c0c85051052a830c8ef34df949c8cbace5d602fff7940aa4dc68d6f884";
const PIN_BASELINE_TH = "0xadfa0bea0f85d7560d7483cd6d56c4b46a1607cf4612d9f590e7807a3242b135";
const PIN_FINAL_TH = "0xb8e1333e6eab8d6a2a3cfcc5894a8ec6c7711c2efb3ff8ea055eadc836e4a6c3";

const CONTRACT = "0xD37121112F240fE03a18D754B2fdB9dC750034d4" as const;
const CONFIG = { stake: 100_000n, targetXp: 50, durationSeconds: 3_600, minParticipants: 2, maxParticipants: 2, startsAt: 1_800_000_000n, createNonce: PIN_NONCE as `0x${string}` };

test("scheme, policy and config hash match the Solidity pin", () => {
  assert.equal(DUOLINGO_XP_SCHEME, PIN_SCHEME);
  assert.equal(missionPolicyHash(), PIN_POLICY);
  assert.equal(keccak256(stringToHex("LOCK_IN_DUOLINGO_PARITY_NONCE")), PIN_NONCE);
  assert.equal(hashDuolingoConfiguration(CONFIG), PIN_CONFIG);
});

test("the typehashes match the Solidity pin", () => {
  assert.equal(
    keccak256(stringToHex("Baseline(address account,bytes32 configHash,bytes32 identityHash,bytes32 nullifier,uint64 issuedAt,uint64 expiresAt)")),
    PIN_BASELINE_TH,
  );
  assert.equal(
    keccak256(stringToHex("Final(uint256 pactId,address account,bytes32 identityHash,uint32 earnedXp,uint32 targetXp,bytes32 nullifier,uint64 occurredAt,uint64 issuedAt,uint64 expiresAt)")),
    PIN_FINAL_TH,
  );
});

test("a signed baseline recovers to the evidence signer", async () => {
  const message = {
    account: "0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45",
    configHash: PIN_CONFIG,
    identityHash: duolingoIdentityHash("477033640"),
    nullifier: keccak256(stringToHex("baseline-nonce")),
    issuedAt: 1_800_000_000n,
    expiresAt: 1_800_000_300n,
  } as const;
  const signature = await signBaseline(message, CONTRACT);
  const recovered = await recoverTypedDataAddress({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract: CONTRACT },
    types: BASELINE_TYPES,
    primaryType: "Baseline",
    message,
    signature,
  });
  assert.equal(recovered, duolingoEvidenceSignerAddress());
});

test("a signed final recovers to the evidence signer, and a tampered target does not", async () => {
  const message = {
    pactId: 1n,
    account: "0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45",
    identityHash: duolingoIdentityHash("477033640"),
    earnedXp: 60,
    targetXp: 50,
    nullifier: keccak256(stringToHex("final-nonce")),
    occurredAt: 1_800_000_100n,
    issuedAt: 1_800_000_100n,
    expiresAt: 1_800_000_400n,
  } as const;
  const signature = await signFinal(message, CONTRACT);
  const good = await recoverTypedDataAddress({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract: CONTRACT }, types: FINAL_TYPES, primaryType: "Final", message, signature,
  });
  assert.equal(good, duolingoEvidenceSignerAddress());
  // Any changed field recovers a different address, which the contract would reject as a wrong signer.
  const tampered = await recoverTypedDataAddress({
    domain: { ...DUOLINGO_DOMAIN, verifyingContract: CONTRACT }, types: FINAL_TYPES, primaryType: "Final",
    message: { ...message, targetXp: 40 }, signature,
  });
  assert.notEqual(tampered, duolingoEvidenceSignerAddress());
});

test("wrong chain id or verifying contract changes the digest", async () => {
  const message = {
    account: "0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45", configHash: PIN_CONFIG,
    identityHash: duolingoIdentityHash("1"), nullifier: keccak256(stringToHex("n")),
    issuedAt: 1_800_000_000n, expiresAt: 1_800_000_300n,
  } as const;
  const signature = await signBaseline(message, CONTRACT);
  const wrongChain = await recoverTypedDataAddress({
    domain: { ...DUOLINGO_DOMAIN, chainId: 1, verifyingContract: CONTRACT }, types: BASELINE_TYPES, primaryType: "Baseline", message, signature,
  });
  assert.notEqual(wrongChain, duolingoEvidenceSignerAddress());
});

test("the identity is an HMAC pseudonym, not a bare hash of an enumerable id", () => {
  const id = duolingoIdentityHash("477033640");
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.notEqual(id, keccak256(stringToHex("DUOLINGO_ZKTLS_DELTA_V1:athlete:477033640")));
  assert.notEqual(id, keccak256(stringToHex("477033640")));
  // Same signer key must be the one the account uses, so parity holds end to end.
  assert.equal(duolingoEvidenceSignerAddress(), privateKeyToAccount(process.env.DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY as `0x${string}`).address);
});

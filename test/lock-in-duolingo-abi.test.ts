// The client ABI for escrow B, encode/decode round-tripped. A wrong tuple shape here would break the money
// path silently: createPact/joinPact/submitFinal would encode calldata the contract cannot decode, or the
// getPact read would mis-map the pact. viem throws on a mismatched tuple, so encoding a real struct is the
// test. Numeric fields decode back as bigint, which the equality checks account for.

import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { duoPactComponents, lockInDuolingoAbi } from "../src/lock-in-duolingo-abi.js";
import { createPactArgs, joinPactArgs, parseBaselineEvidence, parseFinalEvidence, submitFinalArgs } from "../src/duolingo-escrow-client.js";

const H = (b: string) => `0x${b.repeat(32)}` as Hex;
const SIG = `0x${"cd".repeat(65)}` as Hex;
const NONCE = H("a1");
const baseline = parseBaselineEvidence({
  configHash: H("11"), identityHash: H("22"), nullifier: H("33"),
  issuedAt: "1800000000", expiresAt: "1800000300", signature: SIG,
});
const final = parseFinalEvidence({
  identityHash: H("22"), earnedXp: 60, targetXp: 50, nullifier: H("44"),
  occurredAt: "1800000100", issuedAt: "1800000100", expiresAt: "1800000400", signature: SIG,
});

test("createPact calldata round-trips, carrying the nonce and the baseline struct", () => {
  const args = createPactArgs(
    { stake: 100_000n, targetXp: 50, durationSeconds: 3_600, minParticipants: 2, maxParticipants: 2, startsAt: 1_800_000_000n, createNonce: NONCE },
    baseline,
  );
  const data = encodeFunctionData({ abi: lockInDuolingoAbi, functionName: "createPact", args });
  const decoded = decodeFunctionData({ abi: lockInDuolingoAbi, data });
  assert.equal(decoded.functionName, "createPact");
  const a = decoded.args as readonly unknown[];
  assert.equal(a[0], 100_000n); // stake (uint96 -> bigint)
  assert.equal(a[6], NONCE); // createNonce byte for byte
  assert.deepEqual(a[7], { configHash: H("11"), identityHash: H("22"), nullifier: H("33"), issuedAt: 1_800_000_000n, expiresAt: 1_800_000_300n, signature: SIG });
});

test("joinPact and submitFinal calldata round-trip with their structs", () => {
  const joinData = encodeFunctionData({ abi: lockInDuolingoAbi, functionName: "joinPact", args: joinPactArgs(7n, baseline) });
  const join = decodeFunctionData({ abi: lockInDuolingoAbi, data: joinData });
  assert.equal(join.functionName, "joinPact");
  assert.equal((join.args as readonly unknown[])[0], 7n);

  const finalData = encodeFunctionData({ abi: lockInDuolingoAbi, functionName: "submitFinal", args: submitFinalArgs(7n, final) });
  const decoded = decodeFunctionData({ abi: lockInDuolingoAbi, data: finalData });
  assert.equal(decoded.functionName, "submitFinal");
  const evidence = (decoded.args as readonly unknown[])[1] as Record<string, unknown>;
  // viem decodes uint32 (<= 48 bits) as a number; occurredAt (uint64) stays a bigint.
  assert.equal(evidence.earnedXp, 60);
  assert.equal(evidence.targetXp, 50);
  assert.equal(evidence.occurredAt, 1_800_000_100n);
  assert.equal(evidence.nullifier, H("44"));
});

test("finalizePact and claim take a single pactId", () => {
  for (const functionName of ["finalizePact", "claim"] as const) {
    const data = encodeFunctionData({ abi: lockInDuolingoAbi, functionName, args: [42n] });
    const decoded = decodeFunctionData({ abi: lockInDuolingoAbi, data });
    assert.equal(decoded.functionName, functionName);
    assert.equal((decoded.args as readonly unknown[])[0], 42n);
  }
});

test("the DuoPact tuple has the contract's 16 fields, configHash included", () => {
  const names = duoPactComponents.map((c) => c.name);
  assert.equal(names.length, 16);
  assert.ok(names.includes("configHash"));
  assert.deepEqual(names.slice(-3), ["remainingPool", "finalized", "cancelled"]);
});

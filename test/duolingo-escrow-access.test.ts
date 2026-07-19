import assert from "node:assert/strict";
import test from "node:test";
import { assertEscrowWalletAllowed, EscrowAccessError } from "../src/duolingo-escrow-access.js";

const A = "0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45";
const B = "0x344412229B3b581C19572f9BF1F5d08d4Ae897E6";
const OUTSIDER = "0x000000000000000000000000000000000000dEaD";

function env(value?: string): Record<string, string | undefined> {
  return value === undefined ? {} : { DUOLINGO_ESCROW_ALLOWED_WALLETS: value };
}

function statusOf(wallet: string, environment: Record<string, string | undefined>): number {
  try {
    assertEscrowWalletAllowed(wallet, environment);
  } catch (error) {
    assert.ok(error instanceof EscrowAccessError);
    return error.status;
  }
  throw new Error("expected the wallet to be refused");
}

test("an unset or empty allowlist closes the escrow with a 403", () => {
  for (const value of [undefined, "", "   "]) {
    assert.equal(statusOf(A, env(value)), 403);
  }
});

test("a misconfigured allowlist fails closed with a 503, not open", () => {
  assert.equal(statusOf(A, env("not-an-address")), 503);
});

test("the explicit public marker allows any valid wallet", () => {
  assert.doesNotThrow(() => assertEscrowWalletAllowed(A, env("*")));
  assert.doesNotThrow(() => assertEscrowWalletAllowed(OUTSIDER, env(" * ")));
  assert.equal(statusOf("not-a-wallet", env("*")), 400);
});

test("an enabled wallet passes, case-insensitively", () => {
  assert.doesNotThrow(() => assertEscrowWalletAllowed(A.toLowerCase(), env(`${A},${B}`)));
  assert.doesNotThrow(() => assertEscrowWalletAllowed(B, env(`${A}, ${B}`)));
});

test("a wallet outside the list is refused with a 403", () => {
  assert.equal(statusOf(OUTSIDER, env(`${A},${B}`)), 403);
});

test("the escrow allowlist is independent of the preview and canary lists", () => {
  // Being enabled elsewhere grants nothing here: only DUOLINGO_ESCROW_ALLOWED_WALLETS is read.
  const environment = { DUOLINGO_PREVIEW_ALLOWED_WALLETS: A, CANARY_ALLOWED_WALLETS: A };
  assert.throws(() => assertEscrowWalletAllowed(A, environment), EscrowAccessError);
});

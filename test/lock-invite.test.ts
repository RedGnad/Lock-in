import assert from "node:assert/strict";
import test from "node:test";
import { decodeLockInviteCode, encodeLockInviteCode } from "../src/lock-invite";

test("round-trips Lock IDs without collisions", () => {
  const ids = [1n, 31n, 32n, 1_024n, 1_048_575n, 1_048_576n, 4_294_967_295n, (1n << 256n) - 1n];
  const codes = ids.map(encodeLockInviteCode);

  assert.equal(new Set(codes).size, ids.length);
  for (const [index, code] of codes.entries()) assert.equal(decodeLockInviteCode(code), ids[index]);
});

test("produces a short branded canonical code for ordinary Lock IDs", () => {
  const code = encodeLockInviteCode(12n);

  assert.equal(code, "LOCK-000C-4F");
  assert.match(code, /^LOCK-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{2}$/);
  assert.equal(decodeLockInviteCode(code), 12n);
});

test("rejects malformed, ambiguous, non-canonical and mistyped codes", () => {
  const valid = encodeLockInviteCode(12n);
  const wrongChecksum = `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`;

  for (const code of [
    valid.toLowerCase(),
    valid.replace("LOCK-", ""),
    valid.replace("000", "00O"),
    valid.replace("LOCK-", "LOCK-0"),
    wrongChecksum,
    "LOCK-0000-00",
    " LOCK-000C-00",
  ]) assert.equal(decodeLockInviteCode(code), null, code);
});

test("rejects IDs outside the contract uint256 domain", () => {
  assert.throws(() => encodeLockInviteCode(0n), RangeError);
  assert.throws(() => encodeLockInviteCode(-1n), RangeError);
  assert.throws(() => encodeLockInviteCode(1n << 256n), RangeError);
});

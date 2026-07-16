import assert from "node:assert/strict";
import test from "node:test";
import { parsePublicDuolingoProfile } from "../src/duolingo-profile";

test("resolves the exact public username to a stable uint64 profile id", () => {
  assert.deepEqual(parsePublicDuolingoProfile({ users: [
    { id: 123, username: "SomeoneElse" },
    { id: 477033640, username: "RedGnad" },
  ] }, "redgnad"), { id: "477033640", username: "RedGnad" });
});

test("rejects missing, malformed and oversized public profile ids", () => {
  assert.throws(() => parsePublicDuolingoProfile({ users: [] }, "RedGnad"));
  assert.throws(() => parsePublicDuolingoProfile({ users: [{ id: 0, username: "RedGnad" }] }, "RedGnad"));
  assert.throws(() => parsePublicDuolingoProfile({ users: [{ id: "18446744073709551616", username: "RedGnad" }] }, "RedGnad"));
  assert.throws(() => parsePublicDuolingoProfile({ users: [{ id: 1, username: "RedGnad" }] }, "bad username!"));
});

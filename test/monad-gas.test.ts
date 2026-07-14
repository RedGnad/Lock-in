import assert from "node:assert/strict";
import test from "node:test";
import { addMonadGasBuffer } from "../src/monad-gas.js";

test("adds only a five percent Monad gas margin", () => {
  assert.equal(addMonadGasBuffer(100_000n), 105_000n);
  assert.equal(addMonadGasBuffer(1n), 2n);
  assert.throws(() => addMonadGasBuffer(0n), /positive/);
});

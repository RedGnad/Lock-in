import assert from "node:assert/strict";
import test from "node:test";
import { isProofActionEnabled, readProductFlagState } from "../src/product-flags.js";

test("product actions fail closed when flags are missing", () => {
  const state = readProductFlagState({});
  assert.deepEqual(state.actions, {
    newPacts: false,
    join: false,
    checkIns: false,
    settlement: true,
    claim: true,
  });
  assert.equal(state.configuration.allConfigured, false);
  assert.equal(state.mode, "paused");
});

test("only exact boolean strings configure product actions", () => {
  const state = readProductFlagState({
    NEW_PACTS_ENABLED: "true",
    JOIN_ENABLED: "false",
    CHECK_INS_ENABLED: "TRUE",
  });
  assert.equal(state.actions.newPacts, true);
  assert.equal(state.actions.join, false);
  assert.equal(state.actions.checkIns, false);
  assert.deepEqual(state.configuration.configured, {
    NEW_PACTS_ENABLED: true,
    JOIN_ENABLED: true,
    CHECK_INS_ENABLED: false,
  });
  assert.equal(state.configuration.allConfigured, false);
  assert.equal(state.mode, "restricted");
});

test("all enabled flags open risky actions without affecting user exits", () => {
  const state = readProductFlagState({
    NEW_PACTS_ENABLED: "true",
    JOIN_ENABLED: "true",
    CHECK_INS_ENABLED: "true",
  });
  assert.equal(state.configuration.allConfigured, true);
  assert.equal(state.mode, "open");
  assert.deepEqual(state.actions, {
    newPacts: true,
    join: true,
    checkIns: true,
    settlement: true,
    claim: true,
  });
});

test("explicit false flags form a healthy paused configuration", () => {
  const state = readProductFlagState({
    NEW_PACTS_ENABLED: "false",
    JOIN_ENABLED: "false",
    CHECK_INS_ENABLED: "false",
  });
  assert.equal(state.configuration.allConfigured, true);
  assert.equal(state.mode, "paused");
  assert.equal(state.actions.settlement, true);
  assert.equal(state.actions.claim, true);
});

test("proof API actions follow the matching fail-closed product gate", () => {
  const paused = readProductFlagState({
    NEW_PACTS_ENABLED: "false",
    JOIN_ENABLED: "false",
    CHECK_INS_ENABLED: "false",
  });
  assert.equal(isProofActionEnabled(paused, { phase: "baseline", intent: "create" }), false);
  assert.equal(isProofActionEnabled(paused, { phase: "baseline", intent: "join" }), false);
  assert.equal(isProofActionEnabled(paused, { phase: "completion" }), false);

  const restricted = readProductFlagState({
    NEW_PACTS_ENABLED: "true",
    JOIN_ENABLED: "false",
    CHECK_INS_ENABLED: "true",
  });
  assert.equal(isProofActionEnabled(restricted, { phase: "baseline", intent: "create" }), true);
  assert.equal(isProofActionEnabled(restricted, { phase: "baseline", intent: "join" }), false);
  assert.equal(isProofActionEnabled(restricted, { phase: "baseline" }), false);
  assert.equal(isProofActionEnabled(restricted, { phase: "completion" }), true);
});

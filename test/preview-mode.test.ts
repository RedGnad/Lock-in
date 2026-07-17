import assert from "node:assert/strict";
import test from "node:test";
import { isDuolingoPreviewMode } from "../src/preview-mode.js";

test("preview mode redirects only when the flag is exactly true", () => {
  assert.equal(isDuolingoPreviewMode({ DUOLINGO_PREVIEW_MODE: "true" }), true);
});

test("without the flag, the Strava home is unchanged", () => {
  assert.equal(isDuolingoPreviewMode({}), false);
  // Guard against a truthy-but-wrong value opening the redirect on production.
  for (const value of ["", "false", "1", "TRUE", "yes"]) {
    assert.equal(isDuolingoPreviewMode({ DUOLINGO_PREVIEW_MODE: value }), false, `"${value}" must not trigger`);
  }
});

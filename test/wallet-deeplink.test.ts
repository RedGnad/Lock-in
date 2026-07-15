import assert from "node:assert/strict";
import test from "node:test";
import { phantomBrowseUrl } from "../components/wallet-button.js";

test("Phantom browse link preserves the full pact URL", () => {
  const current = "https://lock-in.example/pacts/42?invite=friend%20one#proof";
  const deepLink = new URL(phantomBrowseUrl(current));

  assert.equal(deepLink.origin, "https://phantom.app");
  assert.equal(deepLink.pathname, `/ul/browse/${encodeURIComponent(current)}`);
  assert.equal(deepLink.searchParams.get("ref"), "https://lock-in.example");
});

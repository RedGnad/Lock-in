import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decryptStravaToken,
  encryptStravaToken,
  stravaEncryptionKey,
  StravaCryptoError,
} from "../src/strava-crypto.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const TOKEN = "e5n7q9c1a3f5d7b9e1c3a5f7d9b1e3c5a7f9d1b3";

test("a token survives a round trip and never appears in its own envelope", () => {
  const envelope = encryptStravaToken(TOKEN, KEY);
  assert.equal(decryptStravaToken(envelope, KEY), TOKEN);
  assert.ok(!envelope.includes(TOKEN), "the ciphertext leaked the plaintext");
  assert.ok(envelope.startsWith("v1."), "the envelope must carry its version");
});

test("encrypting the same token twice never produces the same ciphertext", () => {
  // A fresh IV per encryption: otherwise two athletes with the same token would be visibly linked, and a
  // rotation would be visible as a no-op.
  const first = encryptStravaToken(TOKEN, KEY);
  const second = encryptStravaToken(TOKEN, KEY);
  assert.notEqual(first, second);
  assert.equal(decryptStravaToken(first, KEY), decryptStravaToken(second, KEY));
});

test("a tampered envelope fails to decrypt rather than yielding attacker-chosen bytes", () => {
  const envelope = encryptStravaToken(TOKEN, KEY);
  const [version, iv, tag, ciphertext] = envelope.split(".");

  const flipped = Buffer.from(ciphertext, "base64url");
  flipped[0] ^= 0x01;
  for (const broken of [
    [version, iv, tag, flipped.toString("base64url")].join("."),
    [version, iv, Buffer.from(randomBytes(16)).toString("base64url"), ciphertext].join("."),
    [version, Buffer.from(randomBytes(12)).toString("base64url"), tag, ciphertext].join("."),
  ]) {
    assert.throws(() => decryptStravaToken(broken, KEY), StravaCryptoError);
  }
});

test("a token cannot be read with the wrong key", () => {
  const envelope = encryptStravaToken(TOKEN, KEY);
  assert.throws(() => decryptStravaToken(envelope, OTHER_KEY), /could not be decrypted/);
});

test("a malformed envelope is rejected on shape, not attempted", () => {
  for (const broken of ["", "nonsense", "v1.only.three", "v2.a.b.c", TOKEN]) {
    assert.throws(() => decryptStravaToken(broken, KEY), StravaCryptoError);
  }
});

test("the key must be exactly 32 bytes of base64, and its absence fails closed", () => {
  assert.equal(stravaEncryptionKey(KEY.toString("base64")).length, 32);
  assert.throws(() => stravaEncryptionKey(undefined), /not configured/);
  assert.throws(() => stravaEncryptionKey(""), /not configured/);
  assert.throws(() => stravaEncryptionKey(randomBytes(16).toString("base64")), /must decode to 32 bytes/);
  assert.throws(() => stravaEncryptionKey(randomBytes(64).toString("base64")), /must decode to 32 bytes/);
});

test("refuses to encrypt an empty token", () => {
  // An empty refresh token would round-trip happily and then fail far away, at refresh time.
  assert.throws(() => encryptStravaToken("", KEY), /empty token/);
});

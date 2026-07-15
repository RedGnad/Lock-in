import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertCanaryWalletAllowed,
  createWalletAuthChallenge,
  issueWalletAuthSession,
  requireWalletAuthSession,
  verifyWalletAuthChallenge,
  verifyWalletAuthSessionToken,
  WALLET_AUTH_CHALLENGE_TTL_MS,
  WALLET_AUTH_COOKIE_NAME,
  WALLET_AUTH_SESSION_TTL_MS,
  WalletAuthError,
} from "../src/wallet-auth-server.js";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://lock-in.test";
const NONCE = "0123456789abcdef0123456789abcdef";
const ACCOUNT = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OTHER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ENVIRONMENT = { SESSION_SIGNING_SECRET: "test-wallet-session-secret-that-is-longer-than-32-bytes" };

function challenge(environment = ENVIRONMENT) {
  return createWalletAuthChallenge({
    walletAddress: ACCOUNT.address,
    origin: ORIGIN,
    nowMs: NOW,
    nonce: NONCE,
    environment,
  });
}

async function signedSession(environment = ENVIRONMENT) {
  const value = challenge(environment);
  const signature = await ACCOUNT.signMessage({ message: value.message });
  return issueWalletAuthSession({
    challenge: value.challenge,
    signature,
    origin: ORIGIN,
    nowMs: NOW + 1_000,
    environment,
  });
}

function expectAuthStatus(callback: () => unknown, status: WalletAuthError["status"]) {
  assert.throws(callback, (error: unknown) => error instanceof WalletAuthError && error.status === status);
}

test("challenge message explicitly binds domain, origin, wallet, chain, nonce, and expiration", () => {
  const value = challenge();
  assert.equal(value.walletAddress, ACCOUNT.address);
  assert.equal(value.expiresAt, new Date(NOW + WALLET_AUTH_CHALLENGE_TTL_MS).toISOString());
  assert.match(value.message, /Domain: lock-in\.test/);
  assert.match(value.message, /Origin: https:\/\/lock-in\.test/);
  assert.match(value.message, new RegExp(`Wallet: ${ACCOUNT.address}`));
  assert.match(value.message, /Chain ID: 143/);
  assert.match(value.message, new RegExp(`Nonce: ${NONCE}`));
  assert.match(value.message, new RegExp(`Expiration Time: ${new Date(NOW + WALLET_AUTH_CHALLENGE_TTL_MS).toISOString()}`));
});

test("challenge HMAC rejects payload tampering", () => {
  const value = challenge();
  const [encoded, signature] = value.challenge.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  payload.walletAddress = OTHER.address;
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
  expectAuthStatus(() => verifyWalletAuthChallenge({
    challenge: tampered,
    origin: ORIGIN,
    nowMs: NOW + 1_000,
    environment: ENVIRONMENT,
  }), 401);
});

test("challenge expires after five minutes", () => {
  const value = challenge();
  expectAuthStatus(() => verifyWalletAuthChallenge({
    challenge: value.challenge,
    origin: ORIGIN,
    nowMs: NOW + WALLET_AUTH_CHALLENGE_TTL_MS,
    environment: ENVIRONMENT,
  }), 401);
});

test("challenge refuses a signature from another wallet", async () => {
  const value = challenge();
  const wrongSignature = await OTHER.signMessage({ message: value.message });
  await assert.rejects(
    issueWalletAuthSession({
      challenge: value.challenge,
      signature: wrongSignature,
      origin: ORIGIN,
      nowMs: NOW + 1_000,
      environment: ENVIRONMENT,
    }),
    (error: unknown) => error instanceof WalletAuthError && error.status === 401,
  );
});

test("allowlist is optional, exact, and fails closed when malformed", () => {
  assert.equal(assertCanaryWalletAllowed(OTHER.address, ENVIRONMENT), OTHER.address);
  const restricted = {
    ...ENVIRONMENT,
    CANARY_ALLOWED_WALLETS: ` ${ACCOUNT.address.toLowerCase()} `,
  };
  assert.equal(assertCanaryWalletAllowed(ACCOUNT.address, restricted), ACCOUNT.address);
  expectAuthStatus(() => assertCanaryWalletAllowed(OTHER.address, restricted), 403);
  expectAuthStatus(() => assertCanaryWalletAllowed(ACCOUNT.address, {
    ...ENVIRONMENT,
    CANARY_ALLOWED_WALLETS: `${ACCOUNT.address},not-a-wallet`,
  }), 503);
});

test("signed session is bound to wallet and origin for twelve hours", async () => {
  const session = await signedSession();
  assert.equal(session.walletAddress, ACCOUNT.address);
  assert.equal(session.expiresAt, new Date(NOW + 1_000 + WALLET_AUTH_SESSION_TTL_MS).toISOString());

  const verified = verifyWalletAuthSessionToken({
    token: session.token,
    walletAddress: ACCOUNT.address,
    origin: ORIGIN,
    nowMs: NOW + WALLET_AUTH_SESSION_TTL_MS,
    environment: ENVIRONMENT,
  });
  assert.equal(verified.walletAddress, ACCOUNT.address);
  expectAuthStatus(() => verifyWalletAuthSessionToken({
    token: session.token,
    walletAddress: OTHER.address,
    origin: ORIGIN,
    nowMs: NOW + 2_000,
    environment: ENVIRONMENT,
  }), 401);
  expectAuthStatus(() => verifyWalletAuthSessionToken({
    token: session.token,
    walletAddress: ACCOUNT.address,
    origin: "https://other.test",
    nowMs: NOW + 2_000,
    environment: ENVIRONMENT,
  }), 401);
  expectAuthStatus(() => verifyWalletAuthSessionToken({
    token: session.token,
    walletAddress: ACCOUNT.address,
    origin: ORIGIN,
    nowMs: NOW + 1_000 + WALLET_AUTH_SESSION_TTL_MS,
    environment: ENVIRONMENT,
  }), 401);
});

test("session HMAC rejects tampering and cookie auth rejects the wrong wallet", async () => {
  const session = await signedSession();
  const [encoded, signature] = session.token.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  payload.expiresAtMs += WALLET_AUTH_SESSION_TTL_MS;
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
  expectAuthStatus(() => verifyWalletAuthSessionToken({
    token: tampered,
    walletAddress: ACCOUNT.address,
    origin: ORIGIN,
    nowMs: NOW + 2_000,
    environment: ENVIRONMENT,
  }), 401);

  const request = new Request(`${ORIGIN}/api/reclaim/session`, {
    headers: { cookie: `${WALLET_AUTH_COOKIE_NAME}=${session.token}` },
  });
  assert.equal(requireWalletAuthSession(request, ACCOUNT.address, ENVIRONMENT, NOW + 2_000).walletAddress, ACCOUNT.address);
  expectAuthStatus(() => requireWalletAuthSession(request, OTHER.address, ENVIRONMENT, NOW + 2_000), 401);
});

test("existing session stops working when its wallet is removed from the canary allowlist", async () => {
  const session = await signedSession();
  expectAuthStatus(() => verifyWalletAuthSessionToken({
    token: session.token,
    walletAddress: ACCOUNT.address,
    origin: ORIGIN,
    nowMs: NOW + 2_000,
    environment: { ...ENVIRONMENT, CANARY_ALLOWED_WALLETS: OTHER.address },
  }), 403);
});

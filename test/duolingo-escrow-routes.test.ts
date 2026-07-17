// The financial escrow routes must reject unauthorised or misconfigured callers BEFORE any Neon, Reclaim
// or chain access. These exercise exactly those short-circuit paths, the way the money handlers actually
// run, without a database. Anything past the guard (a real proof, a real Lock) belongs to the canary.

process.env.SESSION_SIGNING_SECRET = "test-wallet-session-secret-that-is-longer-than-32-bytes";

import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  createWalletAuthChallenge,
  issueWalletAuthSession,
  WALLET_AUTH_COOKIE_NAME,
} from "../src/wallet-auth-server.js";
import { POST as sessionPost } from "../app/api/duolingo/escrow/session/route.js";
import { POST as verifyPost } from "../app/api/duolingo/escrow/verify/route.js";

const ORIGIN = "https://lock-in.test";
const ENV = { SESSION_SIGNING_SECRET: process.env.SESSION_SIGNING_SECRET };
const A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const B = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

async function cookieFor(account: typeof A): Promise<string> {
  const challenge = createWalletAuthChallenge({
    walletAddress: account.address, origin: ORIGIN, nonce: "0123456789abcdef0123456789abcdef", environment: ENV,
  });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await issueWalletAuthSession({ challenge: challenge.challenge, signature, origin: ORIGIN, environment: ENV });
  return `${WALLET_AUTH_COOKIE_NAME}=${session.token}`;
}

function sessionRequest(body: unknown, cookie?: string): Request {
  return new Request(`${ORIGIN}/api/duolingo/escrow/session`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

const createBody = {
  walletAddress: A.address, intent: "create", username: "someone", targetXp: 50,
  stake: "100000", durationSeconds: 3_600, minParticipants: 2, maxParticipants: 2,
  startsAt: Math.floor(Date.now() / 1_000) + 30 * 60,
};

test("POST /escrow/session without a wallet session is refused", async () => {
  const response = await sessionPost(sessionRequest(createBody));
  assert.equal(response.status, 401);
});

test("a cookie for one wallet cannot open a session for another", async () => {
  const cookie = await cookieFor(A);
  const response = await sessionPost(sessionRequest({ ...createBody, walletAddress: B.address }, cookie));
  assert.equal(response.status, 401);
});

test("an authenticated wallet is refused when the escrow allowlist is closed", async () => {
  delete process.env.DUOLINGO_ESCROW_ALLOWED_WALLETS;
  const cookie = await cookieFor(A);
  const response = await sessionPost(sessionRequest(createBody, cookie));
  assert.equal(response.status, 403);
});

test("an allowed wallet is still refused with 503 until the escrow address is pinned", async () => {
  process.env.DUOLINGO_ESCROW_ALLOWED_WALLETS = A.address;
  delete process.env.DUOLINGO_ESCROW_ADDRESS;
  const cookie = await cookieFor(A);
  const response = await sessionPost(sessionRequest(createBody, cookie));
  assert.equal(response.status, 503);
  const json = await response.json() as { error: string };
  // The failure must not leak which environment variable is missing.
  assert.doesNotMatch(json.error, /DUOLINGO_ESCROW_ADDRESS|env/i);
});

test("POST /escrow/verify rejects a malformed session id before any database access", async () => {
  const response = await verifyPost(new Request(`${ORIGIN}/api/duolingo/escrow/verify`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "!!bad!!" }),
  }));
  assert.equal(response.status, 400);
  const json = await response.json() as { error: string };
  assert.match(json.error, /Invalid Reclaim session/);
});

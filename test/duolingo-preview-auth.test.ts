// The Preview routes must never trust a wallet from the request body or URL. These exercise the DB-free
// rejection paths: an unauthenticated caller, and a caller whose signed cookie is for a different wallet
// than the one it claims. Both fail at the guard, before any Neon access, which is why they can run here.

import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  createWalletAuthChallenge,
  issueWalletAuthSession,
  WALLET_AUTH_COOKIE_NAME,
} from "../src/wallet-auth-server.js";
import { GET as runGet, DELETE as runDelete } from "../app/api/duolingo/run/route.js";
import { POST as sessionPost } from "../app/api/duolingo/session/route.js";

const ORIGIN = "https://lock-in.test";
const ENV = { SESSION_SIGNING_SECRET: "test-wallet-session-secret-that-is-longer-than-32-bytes" };
const A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const B = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

// The routes read process.env, so the signing secret has to live there for the cookie to verify.
process.env.SESSION_SIGNING_SECRET = ENV.SESSION_SIGNING_SECRET;

async function cookieFor(account: typeof A): Promise<string> {
  const challenge = createWalletAuthChallenge({
    walletAddress: account.address, origin: ORIGIN, nonce: "0123456789abcdef0123456789abcdef", environment: ENV,
  });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await issueWalletAuthSession({ challenge: challenge.challenge, signature, origin: ORIGIN, environment: ENV });
  return `${WALLET_AUTH_COOKIE_NAME}=${session.token}`;
}

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, { headers: { origin: ORIGIN, ...(init.headers ?? {}) }, ...init });
}

test("GET /run without a wallet session is refused", async () => {
  const response = await runGet(request(`${ORIGIN}/api/duolingo/run?wallet=${A.address}`));
  assert.equal(response.status, 401);
});

test("DELETE /run without a wallet session is refused", async () => {
  const response = await runDelete(request(`${ORIGIN}/api/duolingo/run?wallet=${A.address}`, { method: "DELETE" }));
  assert.equal(response.status, 401);
});

test("POST /session without a wallet session is refused", async () => {
  const response = await sessionPost(request(`${ORIGIN}/api/duolingo/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: A.address, phase: "baseline", username: "x", targetXp: 100 }),
  }));
  assert.equal(response.status, 401);
});

test("a cookie for one wallet cannot act as another", async () => {
  // Cookie proves A, but the body claims B. requireWalletAuthSession compares the two and refuses.
  const cookie = await cookieFor(A);
  const response = await runGet(request(`${ORIGIN}/api/duolingo/run?wallet=${B.address}`, { headers: { cookie } }));
  assert.equal(response.status, 401);
});

test("POST /session with a cookie for a different wallet than the body is refused", async () => {
  const cookie = await cookieFor(A);
  const response = await sessionPost(request(`${ORIGIN}/api/duolingo/session`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ walletAddress: B.address, phase: "baseline", username: "x", targetXp: 100 }),
  }));
  assert.equal(response.status, 401);
});

test("an authenticated wallet is still refused when the preview allowlist is closed", async () => {
  // Valid cookie for A, but DUOLINGO_PREVIEW_ALLOWED_WALLETS is unset, so the beta is closed to everyone.
  delete process.env.DUOLINGO_PREVIEW_ALLOWED_WALLETS;
  const cookie = await cookieFor(A);
  const response = await sessionPost(request(`${ORIGIN}/api/duolingo/session`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ walletAddress: A.address, phase: "baseline", username: "x", targetXp: 100 }),
  }));
  assert.equal(response.status, 403);
});

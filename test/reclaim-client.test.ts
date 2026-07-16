import assert from "node:assert/strict";
import test from "node:test";
import { openReclaimPopup, runReclaimProof } from "../src/reclaim-client.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const SESSION_ID = "session_12345678";
const HASH = `0x${"11".repeat(32)}`;

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function verifiedResponse() {
  return response({
    verified: true,
    phase: "completion",
    summary: { totalXp: 42 },
    evidence: {
      missionType: 2,
      policyHash: HASH,
      sessionIdHash: HASH,
      identityHash: HASH,
      eventNullifier: HASH,
      metric: "42",
      proofSetHash: HASH,
      occurredAt: "1800000000",
      oldestProofTimestamp: 1_800_000_000,
      newestProofTimestamp: 1_800_000_000,
      movingTimeSeconds: "0",
      elapsedTimeSeconds: "0",
      elevationGainMeters: "0",
      issuedAt: "1800000001",
      expiresAt: "1800000300",
      signature: "0x1234",
    },
    directProof: { sessionId: SESSION_ID, proofs: [] },
  });
}

function installWindow(closeOnNavigate: boolean) {
  const storage = new Map<string, string>();
  const popups: Array<{ closed: boolean }> = [];
  const windowStub = {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    open: () => {
      const popup = {
        closed: false,
        document: { title: "" },
        location: {
          replace: () => {
            if (closeOnNavigate) popup.closed = true;
          },
        },
        close: () => { popup.closed = true; },
      };
      popups.push(popup);
      return popup;
    },
  };
  (globalThis as { window?: unknown }).window = windowStub;
  return { storage, popups };
}

const input = {
  walletAddress: WALLET,
  pactId: "7",
  phase: "completion" as const,
  dayIndex: 2,
  username: "RedGnad",
};

test("waits for a signed proof when Reclaim closes its window during finalization", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const { storage, popups } = installWindow(true);
  const statuses: string[] = [];
  let statusCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/reclaim/session") {
      return response({
        requestUrl: "https://reclaim.example/session",
        sessionId: SESSION_ID,
        token: "signed-token",
        instruction: "Sign in to Duolingo if asked.",
      });
    }
    if (url === "/api/reclaim/status") {
      statusCalls += 1;
      if (statusCalls === 1) return response({ error: "Proof status is temporarily unavailable." }, 503);
      return response(statusCalls === 2 ? { status: "pending", ready: false } : { status: "complete", ready: true });
    }
    if (url === "/api/reclaim/verify") return verifiedResponse();
    throw new Error(`Unexpected URL: ${String(url)}`);
  };

  try {
    const preopenedPopup = openReclaimPopup();
    const result = await runReclaimProof(input, (status) => statuses.push(status), preopenedPopup);
    assert.equal(result.completion?.[5], 42n);
    assert.equal(popups.length, 1);
    assert.equal(statusCalls, 3);
    assert.ok(statuses.includes("Verification service interrupted. Reconnecting…"));
    assert.ok(statuses.includes("Reclaim closed its window. Finishing your signed proof…"));
    assert.equal(storage.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test("keeps a completed session after a transient verification-service failure", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const { storage } = installWindow(false);
  let sessionCalls = 0;
  let verifyCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/reclaim/session") {
      sessionCalls += 1;
      return response({
        requestUrl: "https://reclaim.example/session",
        sessionId: SESSION_ID,
        token: "signed-token",
        instruction: "Sign in to Duolingo if asked.",
      });
    }
    if (url === "/api/reclaim/status") return response({ status: "complete", ready: true });
    if (url === "/api/reclaim/verify") {
      verifyCalls += 1;
      return verifyCalls === 1
        ? response({ error: "Proof verification is temporarily unavailable." }, 503)
        : verifiedResponse();
    }
    throw new Error(`Unexpected URL: ${String(url)}`);
  };

  try {
    await assert.rejects(
      runReclaimProof(input, () => {}),
      /temporarily unavailable/,
    );
    assert.equal(storage.size, 1);

    const statuses: string[] = [];
    const result = await runReclaimProof(input, (status) => statuses.push(status));
    assert.equal(result.completion?.[5], 42n);
    assert.equal(sessionCalls, 1);
    assert.ok(statuses.includes("Resuming your private verification…"));
    assert.equal(storage.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

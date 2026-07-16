import type { BaselineEvidence, CompletionEvidence, DirectProofBundle } from "./lock-in-abi";

type ProofRequestInput = {
  walletAddress: string;
  pactId: string;
  phase: "baseline" | "completion";
  intent?: "create" | "join";
  dayIndex?: number;
  missionType?: number;
  username?: string;
};

type ApiEvidence = {
  missionType: number;
  policyHash: `0x${string}`;
  sessionIdHash: `0x${string}`;
  identityHash: `0x${string}`;
  metric: string;
  eventNullifier?: `0x${string}`;
  proofSetHash: `0x${string}`;
  observedAt?: string;
  occurredAt?: string;
  oldestProofTimestamp?: number;
  newestProofTimestamp?: number;
  movingTimeSeconds?: string;
  elapsedTimeSeconds?: string;
  elevationGainMeters?: string;
  issuedAt: string;
  expiresAt: string;
  signature: `0x${string}`;
};

type SavedProofSession = {
  sessionId: string;
  fingerprint: string;
  requestUrl: string;
  token: string;
  instruction: string;
  createdAt: number;
};

class ProofApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProofApiError";
  }
}

const PROOF_SESSION_MAX_AGE_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const POPUP_CLOSE_GRACE_MS = 15_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

export type ReclaimResult = {
  phase: "baseline" | "completion";
  summary: Record<string, string | number>;
  baseline?: BaselineEvidence;
  completion?: CompletionEvidence;
  directProof: DirectProofBundle;
};

async function json<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new ProofApiError(value.error || "The verification service returned an error", response.status);
  }
  return value;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function proofFingerprint(input: ProofRequestInput): string {
  return JSON.stringify({
    walletAddress: input.walletAddress.toLowerCase(),
    pactId: input.pactId,
    phase: input.phase,
    intent: input.intent || null,
    dayIndex: input.dayIndex ?? null,
    missionType: input.missionType ?? null,
    username: input.username?.trim().toLowerCase() || null,
  });
}

function proofSessionKey(input: ProofRequestInput): string {
  return `lock-in:proof:1:${input.walletAddress.toLowerCase()}:${input.pactId}:${input.phase}:${input.dayIndex ?? input.intent ?? "proof"}`;
}

function readSavedSession(input: ProofRequestInput): SavedProofSession | null {
  try {
    const raw = window.sessionStorage.getItem(proofSessionKey(input));
    const saved = raw ? JSON.parse(raw) as SavedProofSession : null;
    if (
      !saved
        || !/^[A-Za-z0-9_-]{8,128}$/.test(saved.sessionId || "")
        || saved.fingerprint !== proofFingerprint(input)
        || Date.now() - saved.createdAt >= PROOF_SESSION_MAX_AGE_MS
    ) {
      window.sessionStorage.removeItem(proofSessionKey(input));
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

function saveSession(input: ProofRequestInput, session: SavedProofSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(proofSessionKey(input), JSON.stringify(session));
    else window.sessionStorage.removeItem(proofSessionKey(input));
  } catch {}
}

export function openReclaimPopup(): Window | null {
  const popup = window.open("about:blank", "lock-in-reclaim", "popup,width=480,height=760");
  if (popup) {
    popup.document.title = "Preparing verification…";
    try {
      const message = popup.document.createElement("p");
      message.textContent = "Preparing secure verification… Continue in your wallet if asked.";
      message.style.cssText = "margin:48px 24px;font:600 16px/1.5 Arial,sans-serif;color:#161616";
      popup.document.body.replaceChildren(message);
    } catch {
      // The title still communicates progress in browsers that restrict the
      // about:blank document before navigation.
    }
  }
  return popup;
}

export async function runReclaimProof(
  input: ProofRequestInput,
  onStatus: (message: string) => void,
  preopenedPopup?: Window | null,
): Promise<ReclaimResult> {
  const popup = preopenedPopup === undefined ? openReclaimPopup() : preopenedPopup;
  if (!popup) throw new Error("Allow pop-ups to open the private Reclaim verification window");
  popup.document.title = "Opening verification…";
  try {
    let session = readSavedSession(input);
    if (session) {
      onStatus("Resuming your private verification…");
    } else {
      onStatus("Preparing private verification…");
      const created = await json<{ requestUrl: string; sessionId: string; token: string; instruction: string }>(await fetch("/api/reclaim/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }));
      session = { ...created, fingerprint: proofFingerprint(input), createdAt: Date.now() };
      saveSession(input, session);
    }
    if (popup.closed) {
      throw new Error("The verification window closed before it opened. Tap verify again to resume.");
    }
    popup.location.replace(session.requestUrl);
    onStatus(session.instruction);

    const deadline = session.createdAt + PROOF_SESSION_MAX_AGE_MS;
    let ready = false;
    let popupClosedAt: number | null = null;
    let consecutivePollErrors = 0;
    while (Date.now() < deadline) {
      await wait(POLL_INTERVAL_MS);
      let statusResponse: Response;
      try {
        statusResponse = await fetch("/api/reclaim/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: session.token }),
        });
      } catch {
        consecutivePollErrors += 1;
        if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw new Error("The verification connection was interrupted. Tap verify again to resume the same session.");
        }
        onStatus("Connection interrupted. Reconnecting to verification…");
        continue;
      }
      if (statusResponse.status === 429) {
        consecutivePollErrors = 0;
        const requestedDelay = Number(statusResponse.headers.get("Retry-After") || "5");
        const retryAfter = Number.isFinite(requestedDelay)
          ? Math.min(30, Math.max(1, requestedDelay))
          : 5;
        onStatus("Verification is still running. Waiting before the next status check…");
        await wait(retryAfter * 1_000);
        continue;
      }
      if (statusResponse.status >= 500) {
        consecutivePollErrors += 1;
        if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw new Error("The verification service is temporarily unavailable. Tap verify again to resume the same session.");
        }
        onStatus("Verification service interrupted. Reconnecting…");
        continue;
      }
      consecutivePollErrors = 0;
      const status = await json<{ status?: string; ready?: boolean }>(statusResponse);
      if (status.ready) {
        ready = true;
        break;
      }
      if (/fail|error|cancel|reject|expired/i.test(status.status || "")) {
        saveSession(input, null);
        throw new Error("Reclaim ended this verification before creating a proof. Tap verify again to start a new session.");
      }
      if (popup.closed) {
        popupClosedAt ??= Date.now();
        if (Date.now() - popupClosedAt < POPUP_CLOSE_GRACE_MS) {
          onStatus("Reclaim closed its window. Finishing your signed proof…");
          continue;
        }
        throw new Error("Verification paused. Tap verify again to resume the same Reclaim session.");
      }
      popupClosedAt = null;
      onStatus("Complete the verification in the Reclaim window…");
    }
    if (!ready) {
      saveSession(input, null);
      throw new Error("Verification timed out. Start a fresh proof.");
    }

    onStatus("Checking the signed evidence…");
    let verified;
    try {
      verified = await json<{
        verified: boolean;
        phase: "baseline" | "completion";
        summary: Record<string, string | number>;
        evidence: ApiEvidence;
        directProof: DirectProofBundle;
      }>(await fetch("/api/reclaim/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token }),
      }));
    } catch (error) {
      // A completed Reclaim session can be verified again while its signed
      // session token is valid. Keep it for transient backend/rate-limit
      // failures; discard only a definitively rejected client request.
      if (error instanceof ProofApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        saveSession(input, null);
      }
      throw error;
    }
    if (!verified.verified) throw new Error("Evidence verification failed");
    if (
      !verified.directProof
        || verified.directProof.sessionId !== session.sessionId
        || !Array.isArray(verified.directProof.proofs)
    ) throw new Error("The verification service returned an invalid direct proof");
    saveSession(input, null);
    const evidence = verified.evidence;
    if (verified.phase === "baseline") {
      return {
        phase: "baseline",
        summary: verified.summary,
        directProof: verified.directProof,
        baseline: [
          evidence.missionType,
          evidence.policyHash,
          evidence.sessionIdHash,
          evidence.identityHash,
          BigInt(evidence.metric),
          evidence.proofSetHash,
          BigInt(evidence.observedAt || "0"),
          BigInt(evidence.issuedAt),
          BigInt(evidence.expiresAt),
          evidence.signature,
        ],
      };
    }
    return {
      phase: "completion",
      summary: verified.summary,
      directProof: verified.directProof,
      completion: [
        evidence.missionType,
        evidence.policyHash,
        evidence.sessionIdHash,
        evidence.identityHash,
        evidence.eventNullifier || `0x${"00".repeat(32)}`,
        BigInt(evidence.metric),
        evidence.proofSetHash,
        BigInt(evidence.occurredAt || "0"),
        evidence.oldestProofTimestamp || 0,
        evidence.newestProofTimestamp || 0,
        BigInt(evidence.movingTimeSeconds || "0"),
        BigInt(evidence.elapsedTimeSeconds || "0"),
        BigInt(evidence.elevationGainMeters || "0"),
        BigInt(evidence.issuedAt),
        BigInt(evidence.expiresAt),
        evidence.signature,
      ],
    };
  } finally {
    if (!popup.closed) popup.close();
  }
}

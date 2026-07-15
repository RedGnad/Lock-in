import type { BaselineEvidence, CompletionEvidence } from "./lock-in-abi";

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
  identityHash: `0x${string}`;
  totalMetric?: string;
  eventNullifier?: `0x${string}`;
  metric?: string;
  proofHash: `0x${string}`;
  observedAt?: string;
  occurredAt?: string;
  expiresAt: string;
  signature: `0x${string}`;
};

type SavedProofSession = {
  fingerprint: string;
  requestUrl: string;
  token: string;
  instruction: string;
  createdAt: number;
};

export type ReclaimResultV5 = {
  phase: "baseline" | "completion";
  summary: Record<string, string | number>;
  baseline?: BaselineEvidence;
  completion?: CompletionEvidence;
};

async function json<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || "The verification service returned an error");
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
  return `lock-in:proof-v5:${input.walletAddress.toLowerCase()}:${input.pactId}:${input.phase}:${input.dayIndex ?? input.intent ?? "proof"}`;
}

function readSavedSession(input: ProofRequestInput): SavedProofSession | null {
  try {
    const raw = window.sessionStorage.getItem(proofSessionKey(input));
    const saved = raw ? JSON.parse(raw) as SavedProofSession : null;
    if (!saved || saved.fingerprint !== proofFingerprint(input) || Date.now() - saved.createdAt >= 20 * 60_000) {
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

export async function runReclaimProofV5(
  input: ProofRequestInput,
  onStatus: (message: string) => void,
): Promise<ReclaimResultV5> {
  const popup = window.open("about:blank", "lock-in-reclaim", "popup,width=480,height=760");
  if (!popup) throw new Error("Allow pop-ups to open the private Reclaim verification window");
  popup.document.title = "Opening verification…";
  try {
    let session = readSavedSession(input);
    if (session) {
      onStatus("Resuming your private verification…");
    } else {
      onStatus("Preparing private verification…");
      const created = await json<{ requestUrl: string; token: string; instruction: string }>(await fetch("/api/reclaim/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }));
      session = { ...created, fingerprint: proofFingerprint(input), createdAt: Date.now() };
      saveSession(input, session);
    }
    popup.location.replace(session.requestUrl);
    onStatus(session.instruction);

    const deadline = Date.now() + 20 * 60_000;
    let proofs: unknown = null;
    while (Date.now() < deadline) {
      await wait(5_000);
      const statusResponse = await fetch("/api/reclaim/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token }),
      });
      if (statusResponse.status === 429) {
        const retryAfter = Math.min(30, Math.max(1, Number(statusResponse.headers.get("Retry-After") || "5")));
        onStatus("Verification is still running. Waiting before the next status check…");
        await wait(retryAfter * 1_000);
        continue;
      }
      const status = await json<{ status?: string; proofs?: unknown }>(statusResponse);
      if (status.proofs) {
        proofs = status.proofs;
        break;
      }
      if (/fail|error|cancel|reject|expired/i.test(status.status || "")) {
        saveSession(input, null);
        throw new Error("Reclaim verification was cancelled or failed");
      }
      if (popup.closed) {
        throw new Error("Verification paused. Return here and tap verify again to resume the same Reclaim session.");
      }
      onStatus("Complete the verification in the Reclaim window…");
    }
    if (!proofs) {
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
      }>(await fetch("/api/reclaim/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token, proofs }),
      }));
    } catch (error) {
      saveSession(input, null);
      throw error;
    }
    if (!verified.verified) throw new Error("Evidence verification failed");
    saveSession(input, null);
    const evidence = verified.evidence;
    if (verified.phase === "baseline") {
      return {
        phase: "baseline",
        summary: verified.summary,
        baseline: [
          evidence.identityHash,
          BigInt(evidence.totalMetric || "0"),
          evidence.proofHash,
          BigInt(evidence.observedAt || "0"),
          BigInt(evidence.expiresAt),
          evidence.signature,
        ],
      };
    }
    return {
      phase: "completion",
      summary: verified.summary,
      completion: [
        evidence.identityHash,
        evidence.eventNullifier || `0x${"00".repeat(32)}`,
        BigInt(evidence.metric || "0"),
        evidence.proofHash,
        BigInt(evidence.occurredAt || "0"),
        BigInt(evidence.expiresAt),
        evidence.signature,
      ],
    };
  } finally {
    if (!popup.closed) popup.close();
  }
}

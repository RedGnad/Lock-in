import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PendingProofSession = {
  sessionId: string;
  providerId: string;
  providerVersion: string;
  walletAddress: string;
  pactId: string;
  dayIndex: number;
  pactChallenge: string;
  proofCode: string;
  startsAtMs: number;
  endsAtMs: number;
  minDistanceMeters: number;
  createdAt: string;
};

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{8,200}$/;

function sessionPath(root: string, sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("Unsafe Reclaim session ID");
  return join(root, "pending", `${sessionId}.json`);
}

export async function savePendingSession(
  root: string,
  session: PendingProofSession,
): Promise<void> {
  const path = sessionPath(root, session.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function loadPendingSession(
  root: string,
  sessionId: string,
): Promise<PendingProofSession> {
  const raw = await readFile(sessionPath(root, sessionId), "utf8");
  return JSON.parse(raw) as PendingProofSession;
}

export async function consumeSessionOnce(
  root: string,
  sessionId: string,
  nullifier: string,
): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/i.test(nullifier)) throw new Error("Invalid activity nullifier");
  const path = join(root, "consumed", `${sessionId}.json`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify({ sessionId, nullifier, consumedAt: new Date().toISOString() })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("REPLAYED_SESSION: this Reclaim session was already accepted");
    }
    throw error;
  }

  const nullifierPath = join(root, "consumed", "nullifiers", `${nullifier.toLowerCase()}.json`);
  await mkdir(dirname(nullifierPath), { recursive: true });
  try {
    await writeFile(nullifierPath, `${JSON.stringify({ sessionId, nullifier, consumedAt: new Date().toISOString() })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("REUSED_ACTIVITY: this Strava activity already settled another pact");
    }
    throw error;
  }
}

async function pruneDirectory(
  directory: string,
  shouldDelete: (value: Record<string, unknown>) => boolean,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const path = join(directory, entry.name);
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        if (shouldDelete(value)) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }));
}

export async function pruneSessionStore(
  root: string,
  nowMs = Date.now(),
): Promise<void> {
  const incidentRetentionMs = 30 * 24 * 60 * 60 * 1_000;
  await pruneDirectory(join(root, "pending"), (value) => (
    typeof value.endsAtMs === "number" && value.endsAtMs + 24 * 60 * 60 * 1_000 < nowMs
  ));
  const consumedExpired = (value: Record<string, unknown>) => (
    typeof value.consumedAt === "string"
      && Date.parse(value.consumedAt) + incidentRetentionMs < nowMs
  );
  await pruneDirectory(join(root, "consumed"), consumedExpired);
  await pruneDirectory(join(root, "consumed", "nullifiers"), consumedExpired);
}

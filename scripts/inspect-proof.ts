import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { transformForOnchain, verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import { consumeSessionOnce, loadPendingSession, pruneSessionStore } from "../src/proof-session-store.js";
import {
  assertFreshProofTimestamps,
  STRAVA_PROVIDER_ID,
  STRAVA_PROVIDER_VERSION,
  validateStravaEvidence,
} from "../src/strava-proof-policy.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: pnpm proof:inspect -- path/to/proof.json");

const input = JSON.parse(await readFile(path, "utf8")) as Proof | Proof[];
const proofs = Array.isArray(input) ? input : [input];
if (proofs.length === 0) throw new Error("The proof file is empty");

function untrustedSessionId(proof: Proof): string {
  const context = JSON.parse(proof.claimData.context) as Record<string, unknown>;
  if (typeof context.reclaimSessionId !== "string") {
    throw new Error("Proof has no Reclaim session ID");
  }
  return context.reclaimSessionId;
}

const sessionId = untrustedSessionId(proofs[0]);
if (proofs.some((proof) => untrustedSessionId(proof) !== sessionId)) {
  throw new Error("Proofs from different Reclaim sessions cannot be combined");
}

const sessionsRoot = resolve(process.env.PROOF_SESSION_DIR?.trim() || "sessions");
await pruneSessionStore(sessionsRoot);
const pending = await loadPendingSession(sessionsRoot, sessionId);
if (pending.providerId !== STRAVA_PROVIDER_ID || pending.providerVersion !== STRAVA_PROVIDER_VERSION) {
  throw new Error("The pending session does not use the locked Strava v2 provider");
}

const requireTee = process.env.REQUIRE_TEE_ATTESTATION?.trim().toLowerCase() !== "false";
const appSecret = process.env.SECRET?.trim();
if (requireTee && !appSecret) throw new Error("Missing SECRET required for TEE verification");
const result = await verifyProof(proofs, {
  providerId: STRAVA_PROVIDER_ID,
  providerVersion: STRAVA_PROVIDER_VERSION,
  allowedTags: [],
  ...(requireTee ? { teeAttestation: { appSecret: appSecret! } } : {}),
});
if (!result.isVerified) {
  throw new Error(`Reclaim verification failed: ${result.error?.message || result.error}`);
}
if (requireTee && !result.isTeeAttestationVerified) {
  throw new Error("Reclaim verifier TEE attestation was not verified");
}

assertFreshProofTimestamps(proofs.map((proof) => Number(proof.claimData.timestampS)));
const evidence = validateStravaEvidence(result.data, {
  walletAddress: pending.walletAddress,
  pactId: pending.pactId,
  dayIndex: pending.dayIndex,
  challenge: pending.challenge,
  expectedSessionId: pending.sessionId,
  startsAtMs: pending.startsAtMs,
  endsAtMs: pending.endsAtMs,
  minDistanceMeters: pending.minDistanceMeters,
});

await consumeSessionOnce(sessionsRoot, sessionId, evidence.nullifier);

const output: Record<string, unknown> = {
  verified: true,
  teeAttestationVerified: result.isTeeAttestationVerified === true,
  providerId: STRAVA_PROVIDER_ID,
  providerVersion: STRAVA_PROVIDER_VERSION,
  pactId: pending.pactId,
  dayIndex: pending.dayIndex,
  evidence,
};
if (process.argv.includes("--include-onchain")) {
  output.onchainProofs = proofs.map(transformForOnchain);
}
console.log(JSON.stringify(output, null, 2));

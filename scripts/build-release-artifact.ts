import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fetchProviderConfigs, fetchStatusUrl, verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import { STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION } from "../src/strava-proof-policy.js";
import { DUOLINGO_PROVIDER_ID, DUOLINGO_PROVIDER_VERSION } from "../src/duolingo-proof-policy.js";

/*
 * Builds the PRIVATE release artifact that lets a reviewer reproduce the half of the hybrid proof barrier
 * that the public repo cannot carry.
 *
 * The committed fixture (test/fixtures/*-real-onchain.json) holds only the on-chain half: claimInfo,
 * identifier and witness signature. It deliberately does not carry the top-level `teeAttestation` object
 * or the witness list, so the forge test can prove the Solidity grammar but never `isTeeAttestationVerified`.
 * This script records the off-chain half against the raw capture, and writes it OUTSIDE the repo history
 * (release-artifacts/ is gitignored) because a full TEE token is not something to publish.
 *
 * Usage: pnpm tsx scripts/build-release-artifact.ts <sessions/capture.json> <strava|duolingo>
 */

const inPath = process.argv[2];
const mission = process.argv[3];
if (!inPath || (mission !== "strava" && mission !== "duolingo")) {
  throw new Error("Usage: pnpm tsx scripts/build-release-artifact.ts <capture.json> <strava|duolingo>");
}

const appSecret = process.env.SECRET?.trim();
if (!appSecret) throw new Error("SECRET is required to reproduce the TEE attestation verification");

const providerId = mission === "strava" ? STRAVA_PROVIDER_ID : DUOLINGO_PROVIDER_ID;
const providerVersion = mission === "strava" ? STRAVA_PROVIDER_VERSION : DUOLINGO_PROVIDER_VERSION;

const raw = readFileSync(inPath, "utf8");
const captureSha256 = createHash("sha256").update(raw).digest("hex");
const proofs = JSON.parse(raw) as Proof[];
if (!Array.isArray(proofs) || proofs.length !== 2) {
  throw new Error(`Expected a 2-proof capture, received ${Array.isArray(proofs) ? proofs.length : "a non-array"}`);
}

// The SDK does not export ./package.json, so read the installed manifest off disk to record the exact
// version the verification below actually ran with.
const sdkVersion = (JSON.parse(
  readFileSync(resolve("node_modules/@reclaimprotocol/js-sdk/package.json"), "utf8"),
) as { version: string }).version;

const context = JSON.parse(proofs[0].claimData.context) as Record<string, unknown>;
const sessionId = String(context.reclaimSessionId || "");

/*
 * The barrier has two halves, and only one of them is reproducible after the fact.
 *
 * Signature + witness + content pin are durable: they re-verify from the captured bytes at any time.
 * TEE attestation verification is TIME-BOUND by design (the attestation is validated near-real-time), so
 * replaying it hours after the capture fails on a still-genuine proof. Production never hits that: the
 * verify route validates within minutes of generation, and the on-chain verifier independently rejects
 * anything older than MAX_PROOF_AGE_SECONDS (10 minutes).
 *
 * Both halves are therefore recorded separately, with their real results. Run this script DURING the
 * capture window to obtain a green TEE half.
 */
const contentVerification = await verifyProof(proofs, { providerId, providerVersion, allowedTags: [] });

// verifyProof reports a failed TEE by RETURNING { isVerified: false, error }, it does not throw. Deciding
// on a thrown exception would silently record a green TEE half for a red result.
let teeVerification: { isVerified?: boolean; error?: unknown } | undefined;
let teeError: string | undefined;
try {
  teeVerification = await verifyProof(proofs, {
    providerId,
    providerVersion,
    allowedTags: [],
    teeAttestation: { appSecret },
  });
} catch (error) {
  teeError = error instanceof Error ? error.message : String(error);
}
const teeVerified = teeVerification?.isVerified === true;

const attestationTimestamp = (proofs[0].teeAttestation as Record<string, unknown> | undefined)?.timestamp;
const attestationAgeHours = typeof attestationTimestamp === "string"
  ? (Date.now() - Date.parse(attestationTimestamp)) / 3_600_000
  : undefined;

// 2. The session's own terminal state and the provider version Reclaim says it actually executed.
const status = await fetchStatusUrl(sessionId);

// 3. The live provider configuration at the moment of the release.
const configResponse = await fetchProviderConfigs(providerId, providerVersion, []);
const config = configResponse.providers?.[0];

const artifact = {
  generatedAt: new Date().toISOString(),
  mission,
  capture: { path: inPath, sha256: captureSha256, proofCount: proofs.length },
  sdk: { package: "@reclaimprotocol/js-sdk", version: sdkVersion },
  contentBarrier: {
    call: `verifyProof(proofs, { providerId: "${providerId}", providerVersion: "${providerVersion}", allowedTags: [] })`,
    note: "Durable: signature + witness + content pin re-verify from the captured bytes at any time.",
    result: contentVerification,
  },
  teeBarrier: {
    call: `verifyProof(proofs, { providerId: "${providerId}", providerVersion: "${providerVersion}", allowedTags: [], teeAttestation: { appSecret } })`,
    note:
      "TIME-BOUND: TEE attestation is validated near-real-time, so a replay hours after capture fails on a "
      + "genuine proof. A green result here is only meaningful when this script runs during the capture window.",
    attestationTimestamp,
    attestationAgeHoursAtRun: attestationAgeHours,
    reproducedNow: teeVerified,
    result: teeVerification,
    error: teeError,
  },
  session: {
    sessionId: status.session?.sessionId,
    appId: status.session?.appId,
    providerId: status.session?.providerId,
    providerVersionString: status.session?.providerVersionString,
    statusV2: status.session?.statusV2,
  },
  liveProviderConfig: {
    verificationType: config?.verificationType,
    injectionType: config?.injectionType,
    version: (config as unknown as { version?: unknown })?.version,
    requiredRequests: config?.requestData?.length,
  },
  teeAttestations: proofs.map((proof) => {
    const attestation = proof.teeAttestation as Record<string, unknown> | undefined;
    return {
      proof_version: attestation?.proof_version,
      tee_provider: attestation?.tee_provider,
      tee_technology: attestation?.tee_technology,
      timestamp: attestation?.timestamp,
      // Digests only. The attestation token itself stays out of the artifact.
      workload: attestation?.workload,
      verifier: attestation?.verifier,
    };
  }),
  witnesses: proofs.map((proof) => proof.witnesses),
  contextFlags: { isAiProof: context.isAiProof, isPortalProof: context.isPortalProof },
};

const outDir = resolve("release-artifacts");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `${mission}-${providerVersion}-${sessionId}-release-artifact.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

console.log(JSON.stringify({
  wrote: outPath,
  captureSha256,
  sdkVersion,
  contentBarrierVerified: contentVerification.isVerified,
  teeBarrierReproducedNow: teeVerified,
  attestationAgeHoursAtRun: attestationAgeHours === undefined ? undefined : Number(attestationAgeHours.toFixed(2)),
  statusV2: status.session?.statusV2,
  providerVersionString: status.session?.providerVersionString,
  verificationType: config?.verificationType,
}, null, 2));

if (!teeVerified) {
  console.warn(
    "\nTEE half NOT reproduced in this run. If the capture is old this is expected and does not impeach the "
    + "proof; the artifact records it explicitly. Generate the artifact during the capture window for a green "
    + "TEE half.",
  );
}

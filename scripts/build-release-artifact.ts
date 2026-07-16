import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fetchStatusUrl, verifyProof, verifyTeeAttestation, type Proof } from "@reclaimprotocol/js-sdk";
import { assertReclaimSessionProvenance } from "../src/reclaim-onchain.js";
import { assertLiveProviderForMission } from "../src/reclaim-provider-check.js";
import { STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION } from "../src/strava-proof-policy.js";
import { DUOLINGO_PROVIDER_ID, DUOLINGO_PROVIDER_VERSION } from "../src/duolingo-proof-policy.js";

/*
 * Builds the release artifact recording the half of the hybrid proof barrier that the public repo cannot
 * carry. The committed fixtures hold only the on-chain half (claimInfo, identifier, witness signature),
 * never the TEE attestation token, so a forge test can prove the Solidity grammar but never
 * `isTeeAttestationVerified`. Output goes to gitignored release-artifacts/.
 *
 * Two modes, because the two halves age differently:
 *
 *   --require-fresh  Release gate. Exits non-zero unless EVERY barrier is green: content validation, TEE
 *                    attestation, session provenance, and the live provider configuration. Run it within
 *                    the attestation's validity window, immediately after the capture.
 *   --audit-old      Analysis. Records red results without failing, for a capture whose attestation has
 *                    already expired.
 *
 * Signature, witness and content pin re-verify from the captured bytes indefinitely. TEE attestation does
 * not: the SDK checks the attestation JWT's nbf/exp/iat with a 60s tolerance (TOKEN_CLOCK_SKEW_S), and the
 * observed tokens carry a 1 hour lifetime (exp - iat = 3600). Replaying later fails a still-genuine proof.
 * Production never hits this: the verify route validates within minutes of generation.
 *
 * Usage: pnpm release:artifact <capture.json> <strava|duolingo> [--require-fresh|--audit-old]
 */

const inPath = process.argv[2];
const mission = process.argv[3];
const modeFlag = process.argv[4] || "--require-fresh";
if (!inPath || (mission !== "strava" && mission !== "duolingo")) {
  throw new Error("Usage: pnpm release:artifact <capture.json> <strava|duolingo> [--require-fresh|--audit-old]");
}
if (modeFlag !== "--require-fresh" && modeFlag !== "--audit-old") {
  throw new Error(`Unknown mode ${modeFlag}. Use --require-fresh (release gate) or --audit-old (analysis).`);
}
const requireFresh = modeFlag === "--require-fresh";

const appSecret = process.env.SECRET?.trim();
const appId = process.env.ID?.trim();
if (!appSecret || !appId) throw new Error("ID and SECRET are required to verify the TEE attestation");

const providerId = mission === "strava" ? STRAVA_PROVIDER_ID : DUOLINGO_PROVIDER_ID;
const providerVersion = mission === "strava" ? STRAVA_PROVIDER_VERSION : DUOLINGO_PROVIDER_VERSION;

/** A thrown Error keeps name/message/stack non-enumerable, so JSON.stringify would record `{}`. */
function serialiseError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message }
        : error.cause,
    };
  }
  return error === undefined ? undefined : { message: String(error) };
}

function decodeJwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    // Claims only, never the token: iat/nbf/exp are what make a historical validation auditable.
    return { iat: claims.iat, nbf: claims.nbf, exp: claims.exp, kid: undefined };
  } catch {
    return undefined;
  }
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

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

const failures: string[] = [];
function record(ok: boolean, failure: string): boolean {
  if (!ok) failures.push(failure);
  return ok;
}

// 1. Durable half: signature + witness + content pin against the exact requested provider.
const contentVerification = await verifyProof(proofs, { providerId, providerVersion, allowedTags: [] });
record(contentVerification.isVerified === true, "content validation (signature, witness, content pin) is not verified");

// 2. Time-bound half. verifyProof signals a failed TEE by RETURNING { isVerified: false, error }; it does
//    not throw, so deciding on a caught exception would silently record a green TEE for a red result.
let teeVerification: { isVerified?: boolean; isTeeAttestationVerified?: boolean; error?: unknown } | undefined;
let teeThrew: string | undefined;
try {
  teeVerification = await verifyProof(proofs, {
    providerId,
    providerVersion,
    allowedTags: [],
    teeAttestation: { appSecret },
  });
} catch (error) {
  teeThrew = error instanceof Error ? error.message : String(error);
}
const teeVerified = teeVerification?.isVerified === true && teeVerification?.isTeeAttestationVerified === true;
record(teeVerified, "TEE attestation is not verified (expired attestation, or a genuine failure)");

// Per-proof reason: verifyProof aggregates into one TeeVerificationError, this reports each proof.
// Note the signature is verifyTeeAttestation(proof, appSecret) with the secret as a bare string.
const perProofTee = [] as unknown[];
for (const [index, proof] of proofs.entries()) {
  try {
    const result = await verifyTeeAttestation(proof, appSecret);
    perProofTee.push({ index, isVerified: result.isVerified, error: serialiseError(result.error) });
  } catch (error) {
    perProofTee.push({ index, isVerified: false, error: serialiseError(error) });
  }
}

const attestation = proofs[0].teeAttestation as Record<string, unknown> | undefined;
const attestationTimestamp = attestation?.timestamp;
const attestationAgeHours = typeof attestationTimestamp === "string"
  ? (Date.now() - Date.parse(attestationTimestamp)) / 3_600_000
  : undefined;

// 3. The session's own terminal state and the provider version Reclaim says it actually executed.
const status = await fetchStatusUrl(sessionId);
let sessionProvenance: string | undefined;
try {
  assertReclaimSessionProvenance({
    session: status.session,
    expected: { sessionId, appId, providerId, providerVersion },
  });
} catch (error) {
  sessionProvenance = error instanceof Error ? error.message : String(error);
}
record(sessionProvenance === undefined, `session provenance rejected: ${sessionProvenance}`);

// 4. The live provider configuration, asserted with the same code path as `pnpm provider:check`.
let liveProvider: unknown;
let liveProviderError: string | undefined;
try {
  liveProvider = await assertLiveProviderForMission(mission);
} catch (error) {
  liveProviderError = error instanceof Error ? error.message : String(error);
}
record(liveProviderError === undefined, `live provider configuration rejected: ${liveProviderError}`);

const artifact = {
  generatedAt: new Date().toISOString(),
  mission,
  mode: modeFlag,
  green: failures.length === 0,
  failures,
  release: {
    // Binds the evidence to the exact tree it was produced from. A dirty tree means the artifact does not
    // describe any reviewable commit.
    commit: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    workingTreeClean: git("status", "--porcelain") === "",
  },
  capture: { path: inPath, sha256: captureSha256, proofCount: proofs.length },
  sdk: { package: "@reclaimprotocol/js-sdk", version: sdkVersion },
  contentBarrier: {
    call: `verifyProof(proofs, { providerId, providerVersion: "${providerVersion}", allowedTags: [] })`,
    note: "Durable: re-verifies from the captured bytes at any time.",
    isVerified: contentVerification.isVerified,
    result: contentVerification,
  },
  teeBarrier: {
    call: `verifyProof(proofs, { ..., teeAttestation: { appSecret } })`,
    note:
      "TIME-BOUND: the SDK checks the attestation JWT nbf/exp/iat (60s tolerance); observed tokens live "
      + "1 hour (exp - iat = 3600). A green result is only obtainable inside that window.",
    isVerified: teeVerified,
    attestationTimestamp,
    attestationAgeHoursAtRun: attestationAgeHours,
    jwtClaims: proofs.map((proof) => {
      const proofAttestation = proof.teeAttestation as Record<string, unknown> | undefined;
      const token = (proofAttestation?.attestation as Record<string, unknown> | undefined)?.token;
      return decodeJwtClaims(token);
    }),
    perProof: perProofTee,
    result: teeVerification
      ? { ...teeVerification, error: serialiseError(teeVerification.error) }
      : undefined,
    threw: teeThrew,
  },
  session: {
    sessionId: status.session?.sessionId,
    appId: status.session?.appId,
    providerId: status.session?.providerId,
    providerVersionString: status.session?.providerVersionString,
    statusV2: status.session?.statusV2,
    provenanceRejection: sessionProvenance,
  },
  liveProviderConfig: liveProvider ?? { error: liveProviderError },
  teeAttestations: proofs.map((proof) => {
    const proofAttestation = proof.teeAttestation as Record<string, unknown> | undefined;
    return {
      proof_version: proofAttestation?.proof_version,
      tee_provider: proofAttestation?.tee_provider,
      tee_technology: proofAttestation?.tee_technology,
      timestamp: proofAttestation?.timestamp,
      // Digests only. The attestation token itself stays out of the artifact.
      workload: proofAttestation?.workload,
      verifier: proofAttestation?.verifier,
    };
  }),
  witnesses: proofs.map((proof) => proof.witnesses),
  contextFlags: { isAiProof: context.isAiProof, isPortalProof: context.isPortalProof },
};

const outDir = resolve("release-artifacts");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `${mission}-${providerVersion}-${sessionId}-release-artifact.json`);
const serialised = JSON.stringify(artifact, null, 2);
writeFileSync(outPath, serialised);
// Self-hash of the written bytes, so the artifact can be pinned or signed and later shown unmodified.
const artifactSha256 = createHash("sha256").update(serialised).digest("hex");
writeFileSync(`${outPath}.sha256`, `${artifactSha256}  ${outPath.split("/").pop()}\n`);

console.log(JSON.stringify({
  wrote: outPath,
  artifactSha256,
  captureSha256,
  sdkVersion,
  commit: artifact.release.commit,
  workingTreeClean: artifact.release.workingTreeClean,
  contentBarrierVerified: contentVerification.isVerified,
  teeBarrierVerified: teeVerified,
  attestationAgeHoursAtRun: attestationAgeHours === undefined ? undefined : Number(attestationAgeHours.toFixed(2)),
  statusV2: status.session?.statusV2,
  green: artifact.green,
  failures,
}, null, 2));

if (requireFresh) {
  if (!artifact.release.workingTreeClean) {
    failures.push("working tree is dirty, the artifact does not describe a reviewable commit");
  }
  if (failures.length > 0) {
    console.error(`\nRELEASE GATE FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("\nRun inside the attestation window, immediately after the capture. Nothing may be deployed.");
    process.exit(1);
  }
  console.log("\nRELEASE GATE PASSED: every barrier is green. Pin or sign the artifact hash above.");
} else if (failures.length > 0) {
  console.warn(`\n--audit-old: ${failures.length} barrier(s) red, recorded without failing. NOT a release artifact.`);
}

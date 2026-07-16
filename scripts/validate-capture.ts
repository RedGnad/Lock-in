import "dotenv/config";
import fs from "node:fs";
import { verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import { STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION } from "../src/strava-proof-policy.js";
import { DUOLINGO_PROVIDER_VERSION, duolingoProviderId } from "../src/duolingo-proof-policy.js";

// Runs the REAL production barrier verifyProof (SDK + TEE attestation) on a captured
// proof file and dumps the fields that separate a deterministic WITNESS proof from an
// AI-portal proof. Diagnostic only.

const path = process.argv[2];
const kind = (process.argv[3] || "").trim();
const versionOverride = (process.argv[4] || "").trim();
if (!path || (kind !== "duolingo" && kind !== "strava")) {
  throw new Error("Usage: pnpm tsx scripts/validate-capture.ts <proofs.json> <duolingo|strava> [version]");
}
const appSecret: string = process.env.SECRET?.trim() || "";
if (!appSecret) throw new Error("SECRET is not configured");

const proofs = JSON.parse(fs.readFileSync(path, "utf8")) as Proof[];
const providerId = kind === "duolingo" ? duolingoProviderId() : STRAVA_PROVIDER_ID;
const providerVersion = versionOverride || (kind === "duolingo" ? DUOLINGO_PROVIDER_VERSION : STRAVA_PROVIDER_VERSION);

function dumpFields(p: Proof, i: number) {
  let ctx: Record<string, unknown> = {};
  try { ctx = JSON.parse(p.claimData?.context || "{}"); } catch {}
  const params = p.claimData?.parameters || "";
  console.log(`--- proof[${i}] ---`);
  console.log("  parameters.length:", params.length);
  console.log("  isAiProof:", ctx.isAiProof, "isPortalProof:", ctx.isPortalProof);
  console.log("  providerHash:", ctx.providerHash);
  console.log("  contextAddress:", ctx.contextAddress, "contextMessage:", ctx.contextMessage, "sessionId:", ctx.reclaimSessionId);
  console.log("  owner:", p.claimData?.owner);
  const w = (p as unknown as { witnesses?: { id?: string }[] }).witnesses;
  console.log("  witnesses:", Array.isArray(w) ? w.map((x) => x.id).join(",") : "none");
  console.log("  has top-level teeAttestation:", "teeAttestation" in (p as object));
}

async function main() {
  console.log(`Validating ${proofs.length} ${kind} proof(s) against ${providerId}@${providerVersion}\n`);
  proofs.forEach(dumpFields);
  console.log("\nRunning production barrier verifyProof(allowedTags: [], teeAttestation)...");
  const verified = await verifyProof(proofs, {
    providerId,
    providerVersion,
    allowedTags: [],
    teeAttestation: { appSecret },
  });
  console.log("isVerified:", verified.isVerified);
  console.log("isTeeAttestationVerified:", verified.isTeeAttestationVerified);
  console.log("error:", (verified as { error?: unknown }).error);
}

main().catch((error) => {
  console.error("VALIDATE_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

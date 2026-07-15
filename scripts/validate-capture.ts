import "dotenv/config";
import fs from "node:fs";
import { verifyProof, type Proof } from "@reclaimprotocol/js-sdk";
import { STRAVA_PROVIDER_ID, STRAVA_PROVIDER_VERSION } from "../src/strava-proof-policy.js";
import { DUOLINGO_PROVIDER_VERSION, duolingoProviderId } from "../src/duolingo-proof-policy.js";

// Mirrors app/api/reclaim/verify/route.ts SDK + TEE attestation step against a
// captured proof file, to confirm a live proof set verifies. Diagnostic only.

const path = process.argv[2];
const kind = (process.argv[3] || "").trim();
if (!path || (kind !== "duolingo" && kind !== "strava")) {
  throw new Error("Usage: pnpm tsx scripts/validate-capture.ts <proofs.json> <duolingo|strava>");
}
const appSecret: string = process.env.SECRET?.trim() || "";
if (!appSecret) throw new Error("SECRET is not configured");

const proofs = JSON.parse(fs.readFileSync(path, "utf8")) as Proof[];
const providerId = kind === "duolingo" ? duolingoProviderId() : STRAVA_PROVIDER_ID;
const providerVersion = kind === "duolingo" ? DUOLINGO_PROVIDER_VERSION : STRAVA_PROVIDER_VERSION;

async function main() {
  console.log(`Validating ${proofs.length} ${kind} proof(s) against ${providerId}@${providerVersion}`);
  const verified = await verifyProof(proofs, {
    providerId,
    providerVersion,
    allowedTags: [],
    teeAttestation: { appSecret },
  });
  console.log("isVerified:", verified.isVerified);
  console.log("isTeeAttestationVerified:", verified.isTeeAttestationVerified);
  console.log("data length:", Array.isArray(verified.data) ? verified.data.length : typeof verified.data);
  if (Array.isArray(verified.data)) {
    verified.data.forEach((d, i) => console.log(`trustedData[${i}]:`, JSON.stringify(d)));
  }
}

main().catch((error) => {
  console.error("VALIDATE_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

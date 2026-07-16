import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Proof } from "@reclaimprotocol/js-sdk";
import { toDirectProofBundle } from "../src/reclaim-onchain.js";
import { STRAVA_PROVIDER_VERSION } from "../src/strava-proof-policy.js";

// Transforms a captured Strava proof pair into the exact on-chain structs (canonical
// context so hashClaimInfo matches the signed identifier) and writes an auditable
// fixture for the forge test that exercises the two-claim verifier.

const inPath = process.argv[2];
if (!inPath) throw new Error("Usage: pnpm tsx scripts/transform-strava-proof.ts <captured-proofs.json>");
const proofs = JSON.parse(readFileSync(inPath, "utf8")) as Proof[];
if (proofs.length !== 2) throw new Error(`Expected 2 proofs, got ${proofs.length}`);

type OnchainProof = {
  claimInfo: { provider: string; parameters: string; context: string };
  signedClaim: {
    claim: { identifier: string; owner: string; timestampS: number; epoch: number };
    signatures: string[];
  };
};

const ctx0 = JSON.parse(proofs[0].claimData.context) as Record<string, unknown>;
const bundle = toDirectProofBundle(String(ctx0.reclaimSessionId || ""), proofs);
const out = bundle.proofs as unknown as OnchainProof[];

const extracted = proofs.map((p) => {
  const c = JSON.parse(p.claimData.context) as Record<string, unknown>;
  return (c.extractedParameters || {}) as Record<string, unknown>;
});

const fixture = {
  sessionId: String(ctx0.reclaimSessionId || ""),
  account: String(ctx0.contextAddress || ""),
  contextMessage: String(ctx0.contextMessage || ""),
  isAiProof: ctx0.isAiProof,
  isPortalProof: ctx0.isPortalProof,
  markerExtracted: extracted[0],
  activityExtracted: extracted[1],
  proofs: out.map((o) => ({
    provider: o.claimInfo.provider,
    parameters: o.claimInfo.parameters,
    context: o.claimInfo.context,
    identifier: o.signedClaim.claim.identifier,
    owner: o.signedClaim.claim.owner,
    timestampS: o.signedClaim.claim.timestampS,
    epoch: o.signedClaim.claim.epoch,
    signature: o.signedClaim.signatures[0],
    signatureCount: o.signedClaim.signatures.length,
  })),
};

// The fixture embeds a real wallet address and a real Strava account id, so it is written to a
// gitignored private directory, never into the public test tree.
const outDir = resolve(process.env.LOCK_IN_PRIVATE_FIXTURES || "private-fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `strava-real-onchain-${STRAVA_PROVIDER_VERSION}.json`);
writeFileSync(outPath, JSON.stringify(fixture, null, 2));
console.log("wrote", outPath);
console.log("sessionId", fixture.sessionId, "account", fixture.account, "contextMessage", fixture.contextMessage);
console.log("isAiProof", fixture.isAiProof, "isPortalProof", fixture.isPortalProof);
fixture.proofs.forEach((p, i) => console.log(`proof[${i}] id=${p.identifier} owner=${p.owner} ts=${p.timestampS} epoch=${p.epoch} sigs=${p.signatureCount} paramLen=${p.parameters.length}`));
console.log("activity fields:", Object.keys(fixture.activityExtracted));

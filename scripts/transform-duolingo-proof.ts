import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Proof } from "@reclaimprotocol/js-sdk";
import { toDirectProofBundle } from "../src/reclaim-onchain.js";
import { DUOLINGO_PROVIDER_VERSION } from "../src/duolingo-proof-policy.js";

// Transforms the captured real Duolingo proofs into the exact on-chain structs and
// writes an auditable fixture the forge test feeds to the FINAL verifier grammar.

const inPath = process.argv[2];
if (!inPath) throw new Error("Usage: pnpm tsx scripts/transform-duolingo-proof.ts <captured-proofs.json>");
const proofs = JSON.parse(readFileSync(inPath, "utf8")) as Proof[];
if (proofs.length !== 2) throw new Error(`Expected 2 proofs, got ${proofs.length}`);

type OnchainProof = {
  claimInfo: { provider: string; parameters: string; context: string };
  signedClaim: {
    claim: { identifier: string; owner: string; timestampS: number; epoch: number };
    signatures: string[];
  };
};

// Use the app's real bundler: it canonicalizes the context so hashClaimInfo matches
// the signed identifier, exactly as the on-chain verifier expects.
const sessionCtx = JSON.parse(proofs[0].claimData.context) as Record<string, unknown>;
const bundle = toDirectProofBundle(String(sessionCtx.reclaimSessionId || ""), proofs);
const out = bundle.proofs as unknown as OnchainProof[];

// Pull the shared policy inputs the verifier needs, straight from the signed context.
const ctx0 = JSON.parse(proofs[0].claimData.context) as Record<string, unknown>;
const sessionId = String(ctx0.reclaimSessionId || "");
const account = String(ctx0.contextAddress || "");
const contextMessage = String(ctx0.contextMessage || "");
const xpCtx = JSON.parse(proofs[1].claimData.context) as Record<string, unknown>;
const extracted = (xpCtx.extractedParameters || {}) as Record<string, unknown>;

const fixture = {
  sessionId,
  account,
  contextMessage,
  pactId: contextMessage.split(":")[0] || "0",
  baseline: contextMessage.endsWith(":baseline"),
  totalXp: String(extracted.xp || ""),
  profileId: String(extracted.id || extracted.duolingo_user_id || ""),
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

// The fixture embeds a real wallet address and a real Duolingo account id, so it is written to a
// gitignored private directory, never into the public test tree.
const outDir = resolve(process.env.LOCK_IN_PRIVATE_FIXTURES || "private-fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `duolingo-real-onchain-${DUOLINGO_PROVIDER_VERSION}.json`);
writeFileSync(outPath, JSON.stringify(fixture, null, 2));

console.log("wrote", outPath);
console.log("sessionId", sessionId, "account", account, "contextMessage", contextMessage);
fixture.proofs.forEach((p, i) => {
  console.log(`proof[${i}] identifier=${p.identifier} owner=${p.owner} ts=${p.timestampS} epoch=${p.epoch} sigs=${p.signatureCount}`);
});
console.log("totalXp", fixture.totalXp, "profileId", fixture.profileId);

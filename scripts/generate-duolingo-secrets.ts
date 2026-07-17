import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

/*
 * Generates the two Duolingo-escrow secrets, prints ONLY what is safe to see.
 *
 * - DUOLINGO_IDENTITY_HMAC_KEY: 32 random bytes, base64. Pseudonymises the Duolingo profile id.
 * - DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY: a fresh signing key. Its PUBLIC address is printed for the gate;
 *   the private key is written to a gitignored file the owner must move into a secret manager, never Git.
 *
 * Reuse nothing from Strava. Usage: pnpm exec tsx scripts/generate-duolingo-secrets.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";

const hmacKey = randomBytes(32).toString("base64");
const signerKey = `0x${randomBytes(32).toString("hex")}` as const;
const signerAddress = privateKeyToAccount(signerKey).address;

mkdirSync("secrets", { recursive: true });
const path = "secrets/duolingo-secrets.local.txt";
writeFileSync(path, [
  `# Move these into your secret manager, then set them as sensitive Vercel vars. Never commit.`,
  `DUOLINGO_IDENTITY_HMAC_KEY=${hmacKey}`,
  `DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY=${signerKey}`,
  ``,
].join("\n"), { mode: 0o600 });

console.log("Wrote", path, "(gitignored, chmod 600).");
console.log("");
console.log("SAFE TO SHARE — pin this in the gate:");
console.log("  DUOLINGO evidence signer public address:", signerAddress);
console.log("");
console.log("Variable names to configure (values are in the file above, NOT here):");
console.log("  DUOLINGO_IDENTITY_HMAC_KEY");
console.log("  DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY");

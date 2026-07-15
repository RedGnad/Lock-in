import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ReclaimProofRequest, fetchStatusUrl, type Proof } from "@reclaimprotocol/js-sdk";
import { getAddress, isAddress } from "viem";
import { resolvePublicDuolingoProfile } from "../src/duolingo-profile.js";

// Live-schema capture for the private Lock In Duolingo provider. It reproduces the
// exact request the app builds in app/api/reclaim/session/route.ts, opens the Reclaim
// flow in the local Chrome (CDP :9222) so the human only signs in, then polls the
// Reclaim backend and writes the raw proofs for schema inspection. It never stakes,
// never deploys and never flips any gate; it only records what a real proof looks like.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

const providerId = process.env.DUOLINGO_PROVIDER_ID?.trim() || "cdf8cb3b-2976-4413-ab2d-693ae5028380";
const providerVersion = process.env.DUOLINGO_PROVIDER_VERSION?.trim() || "1.0.8";
const username = (process.argv[2] || process.env.DUOLINGO_USERNAME || "").trim();
if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
  throw new Error("Usage: pnpm tsx scripts/capture-duolingo-proof.ts <duolingo-username>");
}
const rawWallet = process.env.WALLET_ADDRESS?.trim() || "0x000000000000000000000000000000000000dEaD";
if (!isAddress(rawWallet)) throw new Error("WALLET_ADDRESS is invalid");
const wallet = getAddress(rawWallet).toLowerCase();
const openCdp = !process.argv.includes("--no-cdp");

async function main() {
  const profile = await resolvePublicDuolingoProfile(username);
  console.log(`Resolved Duolingo profile: username=${profile.username} id=${profile.id}`);

  const request = await ReclaimProofRequest.init(required("ID"), required("SECRET"), providerId, {
    providerVersion,
    acceptTeeAttestation: true,
    canAutoSubmit: true,
    preferredLocale: "en",
  });
  request.setContext(wallet, "0:baseline");
  request.setParams({ duolingo_user_id: profile.id });

  const sessionId = request.getSessionId();
  const requestUrl = await request.getRequestUrl();
  console.log(JSON.stringify({ sessionId, provider: `${providerId}@${providerVersion}`, contextAddress: wallet, requestUrl }, null, 2));

  if (openCdp) {
    try {
      const response = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(requestUrl)}`, { method: "PUT" });
      console.log(response.ok ? "Opened the Reclaim flow in local Chrome (CDP)." : `CDP open failed (${response.status}); open the requestUrl manually.`);
    } catch {
      console.log("No Chrome CDP on :9222; open the requestUrl manually in the browser signed in to Duolingo.");
    }
  }

  console.log("Waiting for the proof. Sign in to Duolingo in the opened tab and let Reclaim finish...");
  const deadline = Date.now() + 8 * 60 * 1_000;
  let proofs: Proof | Proof[] | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    let status;
    try {
      status = await fetchStatusUrl(sessionId);
    } catch {
      continue;
    }
    const raw = String(status.session?.statusV2 || status.message || "");
    if (/fail|error|cancel|reject|expired/i.test(raw)) throw new Error(`Reclaim session ${raw || "failed"}`);
    const ready = status.session?.proofs;
    if (Array.isArray(ready) ? ready.length > 0 : Boolean(ready)) {
      proofs = ready as Proof | Proof[];
      break;
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (!proofs) throw new Error("Timed out before a proof was returned");

  const list = Array.isArray(proofs) ? proofs : [proofs];
  const outDir = resolve("sessions");
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `duolingo-capture-${sessionId}.json`);
  await writeFile(outPath, JSON.stringify(proofs, null, 2));
  console.log(`\nCaptured ${list.length} proof(s) -> ${outPath}\n`);

  list.forEach((proof, index) => {
    const p = proof as Proof;
    let context: Record<string, unknown> = {};
    try { context = JSON.parse(p.claimData?.context || "{}"); } catch {}
    console.log(`--- proof[${index}] ---`);
    console.log("provider:", p.claimData?.provider);
    console.log("parameters:", p.claimData?.parameters);
    console.log("context keys:", Object.keys(context));
    console.log("context.contextMessage:", context.contextMessage);
    console.log("context.contextAddress:", context.contextAddress);
    console.log("has extractedParameters:", Boolean((context as { extractedParameters?: unknown }).extractedParameters));
    console.log("attestation fields present:", Object.keys(context).filter((k) => /attest|nonce|tee/i.test(k)));
    console.log("identifier:", p.identifier);
    console.log("signatures:", Array.isArray(p.signatures) ? p.signatures.length : 0);
  });
}

main().catch((error) => {
  console.error("CAPTURE_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

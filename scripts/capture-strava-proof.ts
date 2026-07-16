import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ReclaimProofRequest, fetchStatusUrl, type Proof } from "@reclaimprotocol/js-sdk";
import { getAddress, isAddress } from "viem";

// Flexible Strava proof capture used to compare provider versions.
// Mirrors the app Strava request: context = wallet + "pactId:dayIndex", param
// context_challenge = the daily proof code that must equal the activity title.
// Diagnostic only: no stake, no deploy, no gate flip.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

const providerId = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
const providerVersion = (process.argv[2] || process.env.STRAVA_VERSION || "6.0.0").trim();
const proofCode = (process.argv[3] || process.env.STRAVA_PROOF_CODE || "").trim();
if (!/^LI-[A-Z0-9]{16,28}D(?:0[1-9]|[12][0-9]|30)$/.test(proofCode)) {
  throw new Error("Usage: pnpm tsx scripts/capture-strava-proof.ts <version> <LI-...D01>");
}
const rawWallet = process.env.WALLET_ADDRESS?.trim() || "0x000000000000000000000000000000000000dEaD";
if (!isAddress(rawWallet)) throw new Error("WALLET_ADDRESS is invalid");
const wallet = getAddress(rawWallet).toLowerCase();
const openCdp = !process.argv.includes("--no-cdp");

async function main() {
  const request = await ReclaimProofRequest.init(required("ID"), required("SECRET"), providerId, {
    providerVersion,
    acceptTeeAttestation: true,
    // Mirrors the production session route exactly. A capture taken under different options would not
    // represent what the app actually accepts.
    acceptAiProviders: false,
    canAutoSubmit: true,
    preferredLocale: "en",
  });
  request.setContext(wallet, "0:0");
  request.setParams({ context_challenge: proofCode });

  const sessionId = request.getSessionId();
  const appMode = process.argv.includes("--app");
  const requestUrl = appMode
    ? await request.getRequestUrl({ verificationMode: "app" } as never)
    : await request.getRequestUrl();
  console.log(JSON.stringify({ sessionId, provider: `${providerId}@${providerVersion}`, mode: appMode ? "app" : "portal", proofCode, contextAddress: wallet }, null, 2));
  console.log("REQUEST_URL:", requestUrl);

  if (openCdp) {
    try {
      const response = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(requestUrl)}`, { method: "PUT" });
      console.log(response.ok ? "Opened the Reclaim flow in local Chrome (CDP)." : `CDP open failed (${response.status}); open manually:\n${requestUrl}`);
    } catch {
      console.log(`No Chrome CDP on :9222; open manually:\n${requestUrl}`);
    }
  }

  console.log("Waiting for the proof...");
  const deadline = Date.now() + 12 * 60 * 1_000;
  let proofs: Proof[] | undefined;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    let status;
    try { status = await fetchStatusUrl(sessionId); } catch { continue; }
    const raw = String(status.session?.statusV2 || status.message || "");
    if (raw && raw !== lastStatus) { console.log(`\nstatus: ${raw}`); lastStatus = raw; }
    if (/fail|error|cancel|reject|expired/i.test(raw)) throw new Error(`Reclaim session ${raw}`);
    const ready = status.session?.proofs as Proof[] | Proof | undefined;
    const list = Array.isArray(ready) ? ready : ready ? [ready] : [];
    if (list.length > 0) { proofs = list; break; }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (!proofs || proofs.length === 0) throw new Error("Timed out before a proof was returned");

  const outDir = resolve("sessions");
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `strava-${providerVersion}-capture-${sessionId}.json`);
  await writeFile(outPath, JSON.stringify(proofs, null, 2));
  console.log(`\nCaptured ${proofs.length} proof(s) -> ${outPath}\n`);
  proofs.forEach((p, i) => {
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(p.claimData?.context || "{}"); } catch {}
    console.log(`--- proof[${i}] ---`);
    console.log("parameters:", p.claimData?.parameters);
    console.log("context keys:", Object.keys(ctx));
    console.log("extractedParameters:", (ctx as Record<string, unknown>).extractedParameters);
    console.log("providerHash:", (ctx as Record<string, unknown>).providerHash);
  });
}

main().catch((error) => {
  console.error("STRAVA_CAPTURE_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

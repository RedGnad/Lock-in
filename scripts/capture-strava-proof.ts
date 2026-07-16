import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ReclaimProofRequest, fetchStatusUrl, type Proof } from "@reclaimprotocol/js-sdk";
import { getAddress, isAddress } from "viem";
import {
  reclaimChannelInitOptions,
  reclaimChannelLaunchOptions,
  resolveReclaimChannel,
} from "../src/reclaim-channel.js";

// Strava proof capture. Mirrors the app request: context = wallet + "pactId:dayIndex", and no
// parameter at all: 7.0.0 reads the athlete's most recent run rather than a titled one.
// Diagnostic only: no stake, no deploy, no gate flip.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

const providerId = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
const providerVersion = (process.argv[2] || process.env.STRAVA_VERSION || "7.0.0").trim();
const rawWallet = process.env.WALLET_ADDRESS?.trim() || "0x000000000000000000000000000000000000dEaD";
if (!isAddress(rawWallet)) throw new Error("WALLET_ADDRESS is invalid");
const wallet = getAddress(rawWallet).toLowerCase();
const openCdp = !process.argv.includes("--no-cdp");
// Same channel resolution as the production session route: --app is a shorthand for the setting, so a
// capture always represents a channel the app can actually serve.
const channel = process.argv.includes("--app") ? "app" as const : resolveReclaimChannel();

async function main() {
  const request = await ReclaimProofRequest.init(required("ID"), required("SECRET"), providerId, {
    providerVersion,
    acceptTeeAttestation: true,
    // Mirrors the production session route exactly. A capture taken under different options would not
    // represent what the app actually accepts.
    acceptAiProviders: false,
    canAutoSubmit: true,
    preferredLocale: "en",
    ...reclaimChannelInitOptions(channel),
  });
  request.setContext(wallet, "0:0");

  const sessionId = request.getSessionId();
  const requestUrl = await request.getRequestUrl(reclaimChannelLaunchOptions(channel));
  console.log(JSON.stringify({ sessionId, provider: `${providerId}@${providerVersion}`, channel, contextAddress: wallet }, null, 2));
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

  // A proof is only usable once its TEE attestation is attached. The status endpoint publishes the
  // proofs array FIRST and fills in teeAttestation shortly after, so saving on the array alone is a race:
  // it silently produces a capture that can never pass the release gate, and the run is wasted. Wait for
  // the terminal state, both proofs, and a token on each, and keep polling for a while after
  // PROOF_SUBMITTED before concluding the attestation is genuinely absent.
  const hasTeeToken = (proof: Proof): boolean =>
    typeof (proof.teeAttestation as { attestation?: { token?: unknown } } | undefined)?.attestation?.token
      === "string";
  const complete = (list: Proof[]): boolean => list.length === 2 && list.every(hasTeeToken);

  const deadline = Date.now() + 12 * 60 * 1_000;
  const attestationGraceMs = 60 * 1_000;
  let proofs: Proof[] | undefined;
  let submittedAt: number | undefined;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    let status;
    try { status = await fetchStatusUrl(sessionId); } catch { continue; }
    const raw = String(status.session?.statusV2 || status.message || "");
    if (raw && raw !== lastStatus) { console.log(`\nstatus: ${raw}`); lastStatus = raw; }
    if (/fail|error|cancel|reject|expired/i.test(raw)) throw new Error(`Reclaim session ${raw}`);
    if (raw === "PROOF_SUBMITTED" && submittedAt === undefined) submittedAt = Date.now();

    const ready = status.session?.proofs as Proof[] | Proof | undefined;
    const list = Array.isArray(ready) ? ready : ready ? [ready] : [];
    if (complete(list)) { proofs = list; break; }

    if (list.length > 0 && submittedAt !== undefined) {
      const waited = Date.now() - submittedAt;
      if (waited > attestationGraceMs) {
        const missing = list.filter((proof) => !hasTeeToken(proof)).length;
        throw new Error(
          `Reclaim returned ${list.length} proof(s) but ${missing} still carry no teeAttestation token `
          + `${Math.round(waited / 1_000)}s after PROOF_SUBMITTED. The status endpoint is not delivering the `
          + "attestation for this session; try the app callback path before spending another run.",
        );
      }
      process.stdout.write("T");
      continue;
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (!proofs) throw new Error("Timed out before a complete, TEE-attested proof set was returned");

  const outDir = resolve("sessions");
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `strava-${providerVersion}-capture-${sessionId}.json`);
  await writeFile(outPath, JSON.stringify(proofs, null, 2));
  console.log(`\nCaptured ${proofs.length} TEE-attested proof(s) -> ${outPath}\n`);
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

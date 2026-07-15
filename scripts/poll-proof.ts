import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchStatusUrl, type Proof } from "@reclaimprotocol/js-sdk";

// Resume-polls an existing Reclaim session by id and records the raw proofs once
// the human finishes the flow. Diagnostic only: no stake, no deploy, no gate flip.

const sessionId = (process.argv[2] || "").trim();
const label = (process.argv[3] || "proof").trim();
if (!sessionId) throw new Error("Usage: pnpm tsx scripts/poll-proof.ts <sessionId> [label]");

function summarize(proofs: Proof[]) {
  proofs.forEach((proof, index) => {
    let context: Record<string, unknown> = {};
    try { context = JSON.parse(proof.claimData?.context || "{}"); } catch {}
    console.log(`--- proof[${index}] ---`);
    console.log("provider:", proof.claimData?.provider);
    console.log("parameters:", proof.claimData?.parameters);
    console.log("context keys:", Object.keys(context));
    console.log("context.contextMessage:", (context as Record<string, unknown>).contextMessage);
    console.log("context.contextAddress:", (context as Record<string, unknown>).contextAddress);
    console.log("attestation-ish keys:", Object.keys(context).filter((k) => /attest|nonce|tee/i.test(k)));
    console.log("identifier:", proof.identifier);
    console.log("signatures:", Array.isArray(proof.signatures) ? proof.signatures.length : 0);
  });
}

async function main() {
  console.log(`Polling session ${sessionId} (up to 12 min). Finish the flow in the browser...`);
  const deadline = Date.now() + 12 * 60 * 1_000;
  let proofs: Proof[] | undefined;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    let status;
    try { status = await fetchStatusUrl(sessionId); } catch { continue; }
    const raw = String(status.session?.statusV2 || status.message || "");
    if (raw && raw !== lastStatus) { console.log(`\nstatus: ${raw}`); lastStatus = raw; }
    if (/fail|error|cancel|reject|expired/i.test(raw)) {
      const detail = JSON.stringify({ statusV2: status.session?.statusV2, message: status.message, sessionMessage: (status.session as { message?: unknown } | undefined)?.message, error: (status.session as { error?: unknown } | undefined)?.error });
      console.log("\nERROR DETAIL:", detail);
      throw new Error(`Reclaim session ${raw}`);
    }
    const ready = status.session?.proofs as Proof[] | Proof | undefined;
    const list = Array.isArray(ready) ? ready : ready ? [ready] : [];
    if (list.length > 0) { proofs = list; break; }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (!proofs || proofs.length === 0) throw new Error("Timed out before a proof was returned");

  const outDir = resolve("sessions");
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `${label}-capture-${sessionId}.json`);
  await writeFile(outPath, JSON.stringify(proofs, null, 2));
  console.log(`\nCaptured ${proofs.length} proof(s) -> ${outPath}\n`);
  summarize(proofs);
}

main().catch((error) => {
  console.error("POLL_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

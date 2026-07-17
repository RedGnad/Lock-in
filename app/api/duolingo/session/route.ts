import { NextResponse } from "next/server";
import { ReclaimProofRequest } from "@reclaimprotocol/js-sdk";
import { getAddress, isAddress } from "viem";
import { readJsonBody } from "@/src/api-guard";
import { DUOLINGO_PROVIDER_ID, DUOLINGO_PROVIDER_VERSION } from "@/src/duolingo-proof-policy";
import { resolvePublicDuolingoProfile } from "@/src/duolingo-profile";
import { loadPreviewRun, savePreviewSession } from "@/src/duolingo-preview-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Opens a Reclaim session for one phase of DUOLINGO_ZKTLS_DELTA_V1.
 *
 * The wallet and the phase are sealed into the SIGNED Reclaim context as `{0}:{phase}`, so a baseline can
 * never come back as a final and a proof cannot be moved between wallets. The profile id is resolved from
 * Duolingo's public API here rather than trusted from the browser: the proof must be bound to the account
 * we asked about, not to whichever account the athlete happens to be signed into.
 *
 * Live Proof Beta: no stake, no escrow, no USDC. The proof engine is the real thing.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1_024);
    const walletRaw = String(body.walletAddress || "");
    if (!isAddress(walletRaw)) throw new Error("Connect a valid wallet first");
    const wallet = getAddress(walletRaw);
    const phase = body.phase === "final" ? "final" : "baseline";
    const username = String(body.username || "").trim();
    if (!username) throw new Error("Enter your Duolingo username");

    // A final with no stored baseline is meaningless, and silently treating it as a baseline would hide
    // the mistake from the athlete.
    const run = phase === "final" ? await loadPreviewRun(wallet) : null;
    if (phase === "final" && !run) throw new Error("Verify your starting XP before your final XP");

    const profile = await resolvePublicDuolingoProfile(username);
    if (run && run.duolingoProfileId !== profile.id) {
      throw new Error("This is a different Duolingo account than the one you started with");
    }

    const appId = process.env.ID?.trim();
    const appSecret = process.env.SECRET?.trim();
    if (!appId || !appSecret) throw new Error("The Reclaim application is not configured");

    const proofRequest = await ReclaimProofRequest.init(appId, appSecret, DUOLINGO_PROVIDER_ID, {
      providerVersion: DUOLINGO_PROVIDER_VERSION,
      // The portal substituted AI-witnessed proofs in July while still reporting success. We ask for TEE
      // and refuse AI here, and the verify route refuses anything without a verified attestation anyway.
      acceptAiProviders: false,
    });
    proofRequest.setParams({ duolingo_user_id: profile.id });
    proofRequest.addContext(wallet.toLowerCase(), `0:${phase}`);

    const sessionId = proofRequest.getStatusUrl().split("/").pop() || "";
    const requestUrl = await proofRequest.getRequestUrl();

    await savePreviewSession({
      sessionId,
      walletAddress: wallet,
      phase,
      duolingoUsername: profile.username,
      duolingoProfileId: profile.id,
    });

    return NextResponse.json({ sessionId, phase, requestUrl, profileId: profile.id }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not start the Duolingo proof",
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
